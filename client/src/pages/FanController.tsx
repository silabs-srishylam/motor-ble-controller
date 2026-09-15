import { useState, useRef, useEffect, useCallback } from 'react';
import { Bluetooth, AlertCircle, CheckCircle2, Zap, Power, FlaskConical } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DebugConsole, type DebugMessage } from '@/components/DebugConsole';
import { MotorVisualizer } from '@/components/MotorVisualizer';
import { SerialTerminal } from '@/components/SerialTerminal';
import {
  SpeedCompareChart,
  type SpeedHistoryPoint,
} from '@/components/SpeedCompareChart';
import { BLE_PROFILES, BLE_SERVICE_UUIDS } from '@/lib/ble-profiles';
import { writeBleCharacteristic } from '@/lib/ble-write';
import { TelemetryStreamParser, type MotorTelemetry, anomalyLabel } from '@/lib/telemetry-parser';
import {
  buildSimTelemetry,
  clampSpeedRadS,
  SIM_SPEED_RAD_S,
  SPEED_RAD_S_MAX,
  SPEED_RAD_S_MIN,
  type SimMotorMode,
} from '@/lib/telemetry-simulator';

/** Max points kept for Speed Compare (SVG redraw cost scales with this). */
const SPEED_HISTORY_MAX = 90;
/** Cap chart React updates — firmware often notifies faster at high RPM. */
const SPEED_CHART_MIN_INTERVAL_MS = 100;
/** Max BLE Debug Console lines retained in memory. */
const DEBUG_CONSOLE_MAX = 1000;

// Web Bluetooth API type definitions
declare global {
  interface Navigator {
    bluetooth: Bluetooth;
  }
  interface Bluetooth {
    requestDevice(options: RequestDeviceOptions): Promise<BluetoothDevice>;
  }
  interface RequestDeviceOptions {
    filters?: BluetoothLEScanFilter[];
    optionalServices?: (string | number)[];
  }
  interface BluetoothLEScanFilter {
    services?: (string | number)[];
  }
  interface BluetoothDevice {
    gatt?: BluetoothRemoteGATTServer;
    addEventListener(type: 'gattserverdisconnected', listener: () => void): void;
    removeEventListener(type: 'gattserverdisconnected', listener: () => void): void;
  }
  interface BluetoothRemoteGATTServer {
    connected: boolean;
    connect(): Promise<BluetoothRemoteGATTServer>;
    disconnect(): void;
    getPrimaryService(service: string): Promise<BluetoothRemoteGATTService>;
  }
  interface BluetoothRemoteGATTService {
    getCharacteristic(characteristic: string): Promise<BluetoothRemoteGATTCharacteristic>;
  }
  interface BluetoothRemoteGATTCharacteristic {
    properties?: {
      read?: boolean;
      write?: boolean;
      writeWithoutResponse?: boolean;
      notify?: boolean;
    };
    value?: DataView;
    readable?: ReadableStream<Uint8Array>;
    startNotifications(): Promise<void>;
    stopNotifications(): Promise<void>;
    writeValue(value: BufferSource): Promise<void>;
    writeValueWithoutResponse?(value: BufferSource): Promise<void>;
    addEventListener(type: string, listener: EventListener): void;
  }
}

type MotorMode = 'stop' | 'low' | 'high' | 'custom';

/** Firmware accepts motor speed refs in 0..300 rad/s (legacy BLE: M<n>, M0 = stop). */
const MOTOR_SPEED_MIN_RAD_S = 0;
const MOTOR_SPEED_MAX_RAD_S = 300;

/** How long transient error banners stay visible before auto-dismiss. */
const ERROR_DISMISS_MS = 5000;

/**
 * FanController Component
 *
 * Web Bluetooth SPP interface for Silicon Labs SiWG917 motor control demo
 * Demonstrates integration of:
 * - Bluetooth Connectivity (Web Bluetooth SPP)
 * - Motor Control (speed reference commands)
 * - Anomaly Detection (AI/ML edge processing)
 */
export default function FanController() {
  const [connected, setConnected] = useState(false);
  const [currentMode, setCurrentMode] = useState<MotorMode>('stop');
  const [motorState, setMotorState] = useState<MotorTelemetry>({
    status: 'Stop',
    speed: 0,
    rpm: 0,
    anomaly: 'NORMAL',
    timestamp: Date.now(),
  });
  const [connectionStatus, setConnectionStatus] = useState<string>('Disconnected');
  const [error, setError] = useState<string | null>(null);
  /** Test Mode only — production Auto-Shutoff is disabled (not on device yet). */
  const [autoShutoffEnabled, setAutoShutoffEnabled] = useState(false);
  const [debugMessages, setDebugMessages] = useState<DebugMessage[]>([]);
  /** True after at least one full telemetry frame arrived over BLE notifications. */
  const [telemetryLive, setTelemetryLive] = useState(false);
  /** Same demo UI + motor visualizer / serial / speed chart. */
  const [testMode, setTestMode] = useState(false);
  /** In Test Mode: true = fake telemetry, false = live BLE from device. */
  const [useSimulatedTelemetry, setUseSimulatedTelemetry] = useState(false);
  /** Custom speed field (rad/s), applied via Set / Enter. */
  const [customSpeedInput, setCustomSpeedInput] = useState('100');
  /** Fan Control setpoint for speed compare chart (rad/s). */
  const [commandedSpeed, setCommandedSpeed] = useState(0);
  const [speedHistory, setSpeedHistory] = useState<SpeedHistoryPoint[]>([]);

  const characteristicRef = useRef<any>(null);
  const deviceRef = useRef<BluetoothDevice | null>(null);
  const telemetryParserRef = useRef<TelemetryStreamParser>(new TelemetryStreamParser());
  const debugMessageIdRef = useRef(0);
  const errorDismissTimerRef = useRef<number | null>(null);
  /** True while the user (or UI) is intentionally tearing down the link. */
  const intentionalDisconnectRef = useRef(false);
  const simIntervalRef = useRef<number | null>(null);
  const simTargetModeRef = useRef<SimMotorMode>('stop');
  const simCustomSpeedRef = useRef(100);
  const commandedSpeedRef = useRef(0);
  const lastChartSampleAtRef = useRef(0);
  const lastChartCommandedRef = useRef(0);

  const clearError = useCallback(() => {
    if (errorDismissTimerRef.current !== null) {
      window.clearTimeout(errorDismissTimerRef.current);
      errorDismissTimerRef.current = null;
    }
    setError(null);
  }, []);

  const showError = useCallback(
    (message: string, durationMs: number = ERROR_DISMISS_MS) => {
      if (errorDismissTimerRef.current !== null) {
        window.clearTimeout(errorDismissTimerRef.current);
      }
      setError(message);
      errorDismissTimerRef.current = window.setTimeout(() => {
        errorDismissTimerRef.current = null;
        clearError();
      }, durationMs);
    },
    [clearError]
  );

  useEffect(() => {
    return () => {
      if (errorDismissTimerRef.current !== null) {
        window.clearTimeout(errorDismissTimerRef.current);
      }
    };
  }, []);

  /** Stable listener refs so handlers always see the latest logic. */
  const onGattDisconnectedRef = useRef<() => void>(() => {});
  const onCharacteristicChangeRef = useRef<(event: Event) => void>(() => {});
  const gattDisconnectedListener = useRef(() => {
    onGattDisconnectedRef.current();
  }).current;
  const characteristicChangeListener = useRef((event: Event) => {
    onCharacteristicChangeRef.current(event);
  }).current;

  const updateCommandedSpeed = useCallback((speed: number) => {
    commandedSpeedRef.current = speed;
    setCommandedSpeed(speed);
  }, []);

  const clearSpeedHistory = useCallback(() => {
    lastChartSampleAtRef.current = 0;
    lastChartCommandedRef.current = commandedSpeedRef.current;
    setSpeedHistory([]);
  }, []);

  const recordSpeedSample = useCallback((actual: number) => {
    const now = Date.now();
    const commanded = commandedSpeedRef.current;
    const commandedChanged = commanded !== lastChartCommandedRef.current;
    // High-speed firmware can flood notifies; Recharts cannot redraw that fast.
    if (
      !commandedChanged
      && now - lastChartSampleAtRef.current < SPEED_CHART_MIN_INTERVAL_MS
    ) {
      return;
    }
    lastChartSampleAtRef.current = now;
    lastChartCommandedRef.current = commanded;
    const point: SpeedHistoryPoint = {
      t: now,
      commanded,
      actual,
    };
    setSpeedHistory((prev) => {
      const next = [...prev, point];
      return next.length > SPEED_HISTORY_MAX ? next.slice(-SPEED_HISTORY_MAX) : next;
    });
  }, []);

  /**
   * Add a message to the debug console
   */
  const addDebugMessage = (type: 'sent' | 'received', data: string, raw?: Uint8Array) => {
    const message: DebugMessage = {
      id: `msg-${debugMessageIdRef.current++}`,
      timestamp: Date.now(),
      type,
      data,
      raw,
    };
    setDebugMessages((prev) => [...prev.slice(-(DEBUG_CONSOLE_MAX - 1)), message]);
  };

  /**
   * Clear debug messages
   */
  const clearDebugMessages = () => {
    setDebugMessages([]);
    debugMessageIdRef.current = 0;
  };

  /**
   * Apply parsed telemetry from BLE notifications (or simulation) to the panel.
   */
  const applyTelemetry = (telemetry: MotorTelemetry) => {
    setTelemetryLive(true);
    setMotorState(telemetry);
    recordSpeedSample(telemetry.speed);

    const absSpeed = Math.abs(telemetry.speed);
    if (telemetry.status === 'Stop' || absSpeed < 1) {
      setCurrentMode('stop');
    } else if (Math.abs(absSpeed - 50) <= 5) {
      setCurrentMode('low');
    } else if (Math.abs(absSpeed - 250) <= 5) {
      setCurrentMode('high');
    } else {
      setCurrentMode('custom');
    }
  };

  const stopTelemetrySimulation = () => {
    if (simIntervalRef.current !== null) {
      window.clearInterval(simIntervalRef.current);
      simIntervalRef.current = null;
    }
    setTelemetryLive(false);
    setCurrentMode('stop');
    updateCommandedSpeed(0);
    clearSpeedHistory();
    setMotorState({
      status: 'Stop',
      speed: 0,
      rpm: 0,
      anomaly: 'NORMAL',
      timestamp: Date.now(),
    });
  };

  const pushSimFrame = (mode: SimMotorMode) => {
    const telemetry = buildSimTelemetry(mode, {
      speedJitter: mode === 'stop' ? 0 : 1.5,
      customSpeed: simCustomSpeedRef.current,
    });
    applyTelemetry(telemetry);
    addDebugMessage(
      'received',
      `[SIM] Motor: ${telemetry.status}  Speed: ${telemetry.speed.toFixed(2)} Anomaly: ${telemetry.anomaly}`
    );
  };

  const startTelemetrySimulation = (initialMode: SimMotorMode = 'low') => {
    if (simIntervalRef.current !== null) {
      window.clearInterval(simIntervalRef.current);
      simIntervalRef.current = null;
    }
    clearError();
    simTargetModeRef.current = initialMode;
    setCurrentMode(initialMode);
    updateCommandedSpeed(
      initialMode === 'custom' ? simCustomSpeedRef.current : SIM_SPEED_RAD_S[initialMode]
    );
    clearSpeedHistory();
    setTelemetryLive(true);
    pushSimFrame(initialMode);
    simIntervalRef.current = window.setInterval(() => {
      pushSimFrame(simTargetModeRef.current);
    }, 500);
    addDebugMessage('sent', `[SIM] Started → ${initialMode}`);
  };

  const setSimMotorMode = (mode: SimMotorMode) => {
    simTargetModeRef.current = mode;
    setCurrentMode(mode);
    updateCommandedSpeed(mode === 'custom' ? simCustomSpeedRef.current : SIM_SPEED_RAD_S[mode]);
    if (simIntervalRef.current === null) {
      startTelemetrySimulation(mode);
      return;
    }
    pushSimFrame(mode);
    addDebugMessage('sent', `[SIM] Mode → ${mode}`);
  };

  const enterTestMode = () => {
    setTestMode(true);
    setUseSimulatedTelemetry(true);
    startTelemetrySimulation('low');
  };

  const exitTestMode = () => {
    stopTelemetrySimulation();
    setUseSimulatedTelemetry(false);
    setTestMode(false);
  };

  /** Test Mode → take telemetry from the real BLE device. */
  const switchToDeviceTelemetry = () => {
    stopTelemetrySimulation();
    setUseSimulatedTelemetry(false);
    clearError();
    addDebugMessage('sent', '[TEST] Switched to device telemetry');
    if (!connected) {
      setTelemetryLive(false);
      setCurrentMode('stop');
      updateCommandedSpeed(0);
      clearSpeedHistory();
      setMotorState({
        status: 'Stop',
        speed: 0,
        rpm: 0,
        anomaly: 'NORMAL',
        timestamp: Date.now(),
      });
    }
  };

  /** Test Mode → use local simulated Motor: frames. */
  const switchToSimulatedTelemetry = () => {
    setUseSimulatedTelemetry(true);
    clearError();
    const mode: SimMotorMode = currentMode === 'stop' ? 'low' : currentMode;
    startTelemetrySimulation(mode);
    addDebugMessage('sent', '[TEST] Switched to simulated telemetry');
  };

  const simActive = testMode && useSimulatedTelemetry;

  useEffect(() => {
    return () => {
      if (simIntervalRef.current !== null) {
        window.clearInterval(simIntervalRef.current);
      }
    };
  }, []);

  /**
   * Resolve the PM firmware GATT service.
   * Probe only the UUID that exists on the device — a missing UUID stalls BlueZ ~30s.
   */
  const resolveBleProfile = async (server: BluetoothRemoteGATTServer) => {
    const withTimeout = <T,>(promise: Promise<T>, ms: number, label: string): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          reject(new Error(`${label} timed out after ${ms}ms`));
        }, ms);
        promise.then(
          (value) => {
            window.clearTimeout(timer);
            resolve(value);
          },
          (err) => {
            window.clearTimeout(timer);
            reject(err);
          }
        );
      });

    const profile = BLE_PROFILES[0];
    setConnectionStatus('Discovering services…');
    const service = await withTimeout(
      server.getPrimaryService(profile.serviceUuid),
      5000,
      'SPP service'
    );
    const characteristic = await withTimeout(
      service.getCharacteristic(profile.characteristicUuid),
      5000,
      'SPP characteristic'
    );
    return { profile, characteristic };
  };

  /**
   * Reset UI / refs after the BLE link is gone.
   * Keeps test-mode simulation telemetry if active.
   */
  const clearConnectionState = () => {
    deviceRef.current = null;
    characteristicRef.current = null;
    telemetryParserRef.current.reset();
    setConnected(false);
    setConnectionStatus('Disconnected');
    if (simIntervalRef.current === null) {
      setCurrentMode('stop');
      setTelemetryLive(false);
      setMotorState({
        status: 'Stop',
        speed: 0,
        rpm: 0,
        anomaly: 'NORMAL',
        timestamp: Date.now(),
      });
    }
  };

  /**
   * Handle unexpected GATT disconnect (device out of range, firmware reset, etc.)
   */
  const handleGattDisconnected = () => {
    const wasIntentional = intentionalDisconnectRef.current;
    intentionalDisconnectRef.current = false;
    clearConnectionState();
    if (!wasIntentional) {
      showError('BLE connection lost. Reconnect to continue.');
    }
  };
  onGattDisconnectedRef.current = handleGattDisconnected;

  /**
   * Connect to Bluetooth device via Web Bluetooth API
   */
  const connectBluetooth = async () => {
    try {
      clearError();
      // Never mix simulated frames with live BLE notify.
      if (simIntervalRef.current !== null) {
        stopTelemetrySimulation();
        setUseSimulatedTelemetry(false);
      }
      intentionalDisconnectRef.current = false;
      setConnectionStatus('Scanning...');

      // Discover devices advertising the PM SPP service (current or legacy adv UUID)
      const device = await navigator.bluetooth.requestDevice({
        filters: BLE_SERVICE_UUIDS.map((uuid) => ({ services: [uuid] })),
        optionalServices: BLE_SERVICE_UUIDS,
      });

      setConnectionStatus('Connecting...');

      // Connect to GATT server and detect which profile the device uses
      const server = await device.gatt!.connect();
      // Brief settle so the first ATT request is not issued during conn-param update.
      await new Promise((resolve) => window.setTimeout(resolve, 50));
      const { characteristic } = await resolveBleProfile(server);

      deviceRef.current = device;
      device.addEventListener('gattserverdisconnected', gattDisconnectedListener);

      characteristicRef.current = characteristic;
      telemetryParserRef.current.reset();
      setTelemetryLive(false);

      // Register before enabling CCCD so the immediate firmware snapshot is not missed.
      setConnectionStatus('Enabling notifications…');
      characteristic.addEventListener('characteristicvaluechanged', characteristicChangeListener);
      await characteristic.startNotifications();

      setConnected(true);
      setConnectionStatus('Connected');
      setCurrentMode('stop');
      updateCommandedSpeed(0);
      setMotorState({
        status: 'Stop',
        speed: 0,
        rpm: 0,
        anomaly: 'NORMAL',
        timestamp: Date.now(),
      });

      // Telemetry updates from characteristicvaluechanged as Motor: frames arrive.
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Connection failed';
      showError(errorMsg);
      setConnectionStatus('Disconnected');
      setConnected(false);
    }
  };

  /**
   * Handle characteristic value changes (notifications).
   * Apply telemetry before debug logging so the panel updates first.
   */
  const handleCharacteristicChange = (event: Event) => {
    if (intentionalDisconnectRef.current) {
      return;
    }
    // Ignore BLE notify while simulation is driving the panel.
    if (simIntervalRef.current !== null) {
      return;
    }
    const characteristic = event.target as any;
    const value = characteristic.value as DataView | undefined;
    if (value) {
      // DataView may share a larger ArrayBuffer — slice the exact GATT payload.
      const rawData = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);

      const telemetryFrames = telemetryParserRef.current.feed(rawData);
      for (const telemetry of telemetryFrames) {
        applyTelemetry(telemetry);
      }

      // Chart + panel only use successfully parsed frames (not raw BLE chunks).
      // Incomplete SPP fragments stay in the stream buffer — do not log them as
      // separate lines (they look like "Motor: Running  Spee" / "d: 100.00 …").
      if (telemetryFrames.length > 0) {
        for (const telemetry of telemetryFrames) {
          addDebugMessage(
            'received',
            `Motor: ${telemetry.status}  Speed: ${telemetry.speed.toFixed(2)} Anomaly: ${telemetry.anomaly}`
          );
        }
      }
    }
  };
  onCharacteristicChangeRef.current = handleCharacteristicChange;

  /**
   * Send command to motor control board
   */
  const sendCommand = async (command: string) => {
    if (!characteristicRef.current || !connected) {
      showError('Not connected to device');
      return;
    }

    try {
      const encoder = new TextEncoder();
      const data = encoder.encode(command + '\n');
      addDebugMessage('sent', command);
      await writeBleCharacteristic(characteristicRef.current, data);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to send command';
      showError(errorMsg);
      if (errorMsg.includes('disconnected') || errorMsg.includes('GATT')) {
        setConnected(false);
        setConnectionStatus('Disconnected');
        characteristicRef.current = null;
      }
    }
  };

  /**
   * Control motor mode — simulated target when Test Mode + Sim, else BLE command.
   */
  const setMotorMode = async (mode: Exclude<MotorMode, 'custom'>) => {
    if (simActive) {
      setSimMotorMode(mode);
      return;
    }

    let command = '';
    let setpoint = 0;

    switch (mode) {
      case 'stop':
        command = 'M0';
        setpoint = 0;
        break;
      case 'low':
        command = 'M50';
        setpoint = 50;
        break;
      case 'high':
        command = 'M250';
        setpoint = 250;
        break;
    }

    // Highlight the pressed control; telemetry panel follows device notify stream.
    setCurrentMode(mode);
    updateCommandedSpeed(setpoint);
    clearError();
    await sendCommand(command);
  };

  /**
   * Set an arbitrary speed reference (rad/s) via legacy BLE M<n> (production UI).
   * Firmware range: 0..300 rad/s (M0 stops, M<n> sets speed + start).
   */
  const setCustomSpeed = async () => {
    const speed = Number.parseInt(customSpeedInput.trim(), 10);
    if (
      !Number.isFinite(speed)
      || speed < MOTOR_SPEED_MIN_RAD_S
      || speed > MOTOR_SPEED_MAX_RAD_S
    ) {
      showError(
        `Enter a speed between ${MOTOR_SPEED_MIN_RAD_S} and ${MOTOR_SPEED_MAX_RAD_S} rad/s`
      );
      return;
    }

    clearError();
    setCurrentMode(speed === 0 ? 'stop' : 'custom');
    updateCommandedSpeed(speed);
    await sendCommand(`M${speed}`);
  };

  /**
   * Apply a user-entered speed (rad/s). Test Mode only. Clamped to [MIN, MAX].
   */
  const applyCustomSpeed = async () => {
    if (!testMode) {
      return;
    }

    const parsed = parseFloat(customSpeedInput);
    if (Number.isNaN(parsed)) {
      showError(`Enter a valid speed between ${SPEED_RAD_S_MIN} and ${SPEED_RAD_S_MAX} rad/s`);
      return;
    }

    const speed = clampSpeedRadS(parsed);
    if (speed !== parsed) {
      setCustomSpeedInput(String(speed));
    }

    const commandValue = Number.isInteger(speed) ? String(speed) : speed.toFixed(2);
    const command = `M${commandValue}`;

    simCustomSpeedRef.current = speed;
    setCurrentMode(speed === 0 ? 'stop' : 'custom');
    updateCommandedSpeed(speed);
    clearError();

    if (simActive) {
      setSimMotorMode(speed === 0 ? 'stop' : 'custom');
      addDebugMessage('sent', `[SIM] ${command}`);
      return;
    }

    if (!connected) {
      showError('Not connected to device');
      return;
    }

    await sendCommand(command);
  };

  /**
   * Toggle auto-shutoff feature (Test Mode / device path only).
   */
  const toggleAutoShutoff = async () => {
    const newState = !autoShutoffEnabled;
    const command = newState ? 'AOFF1' : 'AOFF0';

    try {
      await sendCommand(command);
      setAutoShutoffEnabled(newState);
    } catch {
      showError(`Failed to ${newState ? 'enable' : 'disable'} auto-shutoff`);
    }
  };

  /**
   * Disconnect from Bluetooth device.
   * Drops the GATT link immediately; gattserverdisconnected clears UI state.
   */
  const disconnectBluetooth = () => {
    const device = deviceRef.current;
    const characteristic = characteristicRef.current;
    if (!device && !connected) {
      clearConnectionState();
      return;
    }

    clearError();
    intentionalDisconnectRef.current = true;

    // Update UI immediately — do not wait on stopNotifications (can hang on Linux).
    setConnected(false);
    setConnectionStatus('Disconnected');

    if (characteristic) {
      try {
        characteristic.removeEventListener('characteristicvaluechanged', characteristicChangeListener);
      } catch {
        // Ignore.
      }
    }

    try {
      if (device) {
        device.removeEventListener('gattserverdisconnected', gattDisconnectedListener);
      }
      // Drop the BLE link right away. skip awaiting CCCD clear — disconnect tears it down.
      if (device?.gatt?.connected) {
        device.gatt.disconnect();
      }
    } catch (err) {
      console.error('Disconnect error:', err);
    } finally {
      // Always clear locally; intentional flag suppresses the "connection lost" error
      // if gattserverdisconnected also fires.
      intentionalDisconnectRef.current = true;
      clearConnectionState();
      // Keep flag true briefly so a late gattserverdisconnected does not show an error,
      // then clear it on the next tick.
      window.setTimeout(() => {
        intentionalDisconnectRef.current = false;
      }, 500);
    }
  };

  const bluetoothSupported = 'bluetooth' in navigator;

  /** Shared anomaly panel (NORMAL / SLOWED / BLOCKED). */
  const renderAnomalyPanel = () => (
    <div className="mb-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-medium text-muted-foreground">Anomaly Detection</span>
        <div
          className={`status-led ${
            !telemetryLive
              ? 'bg-muted'
              : motorState.anomaly === 'BLOCKED'
                ? 'bg-red-500 active'
                : motorState.anomaly === 'SLOWED'
                  ? 'bg-yellow-500 active'
                  : 'bg-green-500'
          }`}
        />
      </div>

      <div className="bg-secondary/50 rounded-lg p-4 mb-3">
        <p
          className={`text-2xl font-bold tracking-wide ${
            !telemetryLive
              ? 'text-muted-foreground'
              : motorState.anomaly === 'BLOCKED'
                ? 'text-red-600'
                : motorState.anomaly === 'SLOWED'
                  ? 'text-yellow-600'
                  : 'text-green-600'
          }`}
        >
          {telemetryLive ? motorState.anomaly : '—'}
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          {!telemetryLive ? 'Pending telemetry' : anomalyLabel(motorState.anomaly)}
        </p>
      </div>

      <p className="text-xs text-muted-foreground">
        {!telemetryLive
          ? 'Telemetry starts when BLE notifications deliver Motor: frames'
          : motorState.anomaly === 'NORMAL'
            ? '✓ Normal Operation'
            : motorState.anomaly === 'SLOWED'
              ? '⚠️ Fan running slower than expected'
              : '⛔ Fan blocked or stalled'}
      </p>
    </div>
  );

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-secondary to-background">
      {/* Header with Silicon Labs Branding */}
      <header className="border-b border-border bg-white/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="container py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-primary to-accent flex items-center justify-center">
              <Zap className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-primary">
                Motor BLE Controller
              </h1>
              <p className="text-xs text-muted-foreground">Motor Control Demo</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant={testMode ? 'default' : 'outline'}
              size="sm"
              onClick={() => (testMode ? exitTestMode() : enterTestMode())}
              className={
                testMode
                  ? 'bg-amber-500 hover:bg-amber-600 text-white border-amber-500'
                  : 'border-amber-300 text-amber-800 hover:bg-amber-50'
              }
            >
              <FlaskConical className="w-4 h-4 mr-1.5" />
              {testMode ? 'Exit Test Mode' : 'Test Mode'}
            </Button>
            <div className={`flex items-center gap-2 px-3 py-2 rounded-lg ${connected ? 'bg-green-50' : 'bg-red-50'}`}>
              <div className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`} />
              <span className="text-sm font-medium text-foreground">
                {connected ? 'Connected' : connectionStatus}
              </span>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container py-12">
        {testMode ? (
          /* ——— Test Mode UI ——— */
          <div className="grid lg:grid-cols-3 gap-4 lg:gap-6 items-stretch">
            {/* Cols 1–2: shared 2×2 grid so Fan Control matches Tech Stack height;
                Serial + Speed Compare share the bottom row */}
            <div className="lg:col-span-2 grid min-h-0 gap-4 lg:grid-cols-2 lg:grid-rows-[auto_minmax(280px,1fr)]">
              <div className="bg-white rounded-xl p-6 shadow-sm border border-border flex flex-col w-full h-full">
                <h2 className="text-lg font-bold text-primary mb-4">Technology Stack</h2>
                <div className="space-y-3 flex-1">
                  <div className="flex items-start gap-3">
                    <Bluetooth className="w-5 h-5 text-accent flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="font-medium text-foreground">Bluetooth Connectivity</p>
                      <p className="text-xs text-muted-foreground">Web Bluetooth SPP</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <Zap className="w-5 h-5 text-accent flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="font-medium text-foreground">Motor Control</p>
                      <p className="text-xs text-muted-foreground">PWM Speed Regulation</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <CheckCircle2 className="w-5 h-5 text-accent flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="font-medium text-foreground">Anomaly Detection Active Sign</p>
                      <p className="text-xs text-muted-foreground">AI/ML Edge Processing</p>
                    </div>
                  </div>
                </div>
                <div className="mt-6 pt-6 border-t border-border">
                  {!connected ? (
                    <Button
                      onClick={connectBluetooth}
                      disabled={simActive}
                      className="w-full tech-button bg-accent hover:bg-accent/90 text-accent-foreground"
                    >
                      <Bluetooth className="w-4 h-4 mr-2" />
                      Connect Device
                    </Button>
                  ) : (
                    <Button onClick={disconnectBluetooth} variant="outline" className="w-full tech-button">
                      Disconnect
                    </Button>
                  )}
                  <div className="mt-3 space-y-2">
                    <p className="text-xs text-center font-medium text-amber-800">
                      {simActive
                        ? 'Test Mode: using simulated telemetry'
                        : 'Test Mode: using device telemetry'}
                    </p>
                    <div className="grid grid-cols-2 gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant={simActive ? 'default' : 'outline'}
                        onClick={switchToSimulatedTelemetry}
                        className={
                          simActive
                            ? 'bg-amber-500 hover:bg-amber-600 text-white'
                            : 'border-amber-300 text-amber-800 hover:bg-amber-50'
                        }
                      >
                        Simulated
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant={!simActive ? 'default' : 'outline'}
                        onClick={switchToDeviceTelemetry}
                        className={
                          !simActive
                            ? 'bg-cyan-600 hover:bg-cyan-700 text-white'
                            : 'border-cyan-300 text-cyan-800 hover:bg-cyan-50'
                        }
                      >
                        Device
                      </Button>
                    </div>
                  </div>
                </div>
              </div>

              <div className="bg-white rounded-xl p-6 shadow-sm border border-border flex flex-col w-full h-full">
                <h2 className="text-lg font-bold text-primary mb-4 text-center">Fan Control</h2>
                <div className="space-y-2.5 flex-1">
                  <button
                    onClick={() => setMotorMode('stop')}
                    disabled={!connected && !simActive}
                    className={`w-full tech-button py-3 rounded-lg text-sm font-semibold transition-all ${
                      currentMode === 'stop'
                        ? 'bg-gray-500 text-white shadow-md'
                        : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                    } disabled:opacity-50 disabled:cursor-not-allowed`}
                  >
                    ⏹ Stop
                  </button>
                  <button
                    onClick={() => setMotorMode('low')}
                    disabled={!connected && !simActive}
                    className={`w-full tech-button py-3 rounded-lg text-sm font-semibold transition-all ${
                      currentMode === 'low'
                        ? 'bg-green-500 text-white shadow-md'
                        : 'bg-green-100 text-green-700 hover:bg-green-200'
                    } disabled:opacity-50 disabled:cursor-not-allowed`}
                  >
                    🌀 Low (50 rad/s)
                  </button>
                  <button
                    onClick={() => setMotorMode('high')}
                    disabled={!connected && !simActive}
                    className={`w-full tech-button py-3 rounded-lg text-sm font-semibold transition-all ${
                      currentMode === 'high'
                        ? 'bg-accent text-accent-foreground shadow-md'
                        : 'bg-accent/10 text-accent hover:bg-accent/20'
                    } disabled:opacity-50 disabled:cursor-not-allowed`}
                  >
                    ⚡ High (250 rad/s)
                  </button>
                  <div
                    className={`rounded-lg border p-2.5 transition-all ${
                      currentMode === 'custom'
                        ? 'border-accent bg-accent/5'
                        : 'border-border bg-secondary/30'
                    }`}
                  >
                    <label
                      htmlFor="custom-speed-rad"
                      className="mb-1.5 block text-[11px] font-medium text-muted-foreground"
                    >
                      Custom speed (rad/s)
                    </label>
                    <div className="flex gap-2">
                      <Input
                        id="custom-speed-rad"
                        type="number"
                        inputMode="decimal"
                        min={SPEED_RAD_S_MIN}
                        max={SPEED_RAD_S_MAX}
                        step="any"
                        value={customSpeedInput}
                        disabled={!connected && !simActive}
                        onChange={(e) => setCustomSpeedInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            void applyCustomSpeed();
                          }
                        }}
                        placeholder="e.g. 120"
                        className="font-mono h-8 text-sm"
                      />
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => void applyCustomSpeed()}
                        disabled={!connected && !simActive}
                        className="shrink-0 h-8 bg-primary text-primary-foreground hover:bg-primary/90"
                      >
                        Set
                      </Button>
                    </div>
                  </div>
                </div>
                <div className="mt-auto pt-2 border-t border-border">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <Power className="w-3.5 h-3.5 text-primary shrink-0" />
                      <span className="text-xs font-medium text-foreground">Auto-Shutoff</span>
                      <span className="text-[10px] text-muted-foreground">
                        {autoShutoffEnabled ? 'On' : 'Off'}
                      </span>
                    </div>
                    <button
                      onClick={toggleAutoShutoff}
                      disabled={!connected || simActive}
                      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                        autoShutoffEnabled ? 'bg-accent' : 'bg-gray-300'
                      } disabled:opacity-50 disabled:cursor-not-allowed`}
                      aria-label="Toggle auto-shutoff"
                    >
                      <span
                        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                          autoShutoffEnabled ? 'translate-x-4' : 'translate-x-0.5'
                        }`}
                      />
                    </button>
                  </div>
                </div>
              </div>

              <div className="min-h-0 h-full overflow-hidden">
                <SerialTerminal
                  title="SiWG917 Serial"
                  defaultBaudRate={115200}
                  className="h-full max-h-full"
                />
              </div>

              <SpeedCompareChart
                data={speedHistory}
                commandedSpeed={commandedSpeed}
                className="min-h-0 h-full"
              />
            </div>

            <div className="min-h-0">
              <div className="bg-white rounded-xl p-8 shadow-sm border border-border h-full">
                <h2 className="text-lg font-bold text-primary mb-6 text-center">Real-Time Telemetry</h2>
                <div className="mb-6 flex items-center justify-center gap-2 text-xs font-medium">
                  {simActive && telemetryLive ? (
                    <>
                      <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
                      <span className="text-amber-700">Test Mode · simulated telemetry</span>
                    </>
                  ) : connected && telemetryLive ? (
                    <>
                      <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                      <span className="text-green-700">Test Mode · live via BLE notify</span>
                    </>
                  ) : connected ? (
                    <>
                      <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                      <span className="text-amber-700">Waiting for device telemetry…</span>
                    </>
                  ) : !simActive ? (
                    <span className="text-muted-foreground">Connect device for live telemetry</span>
                  ) : (
                    <span className="text-muted-foreground">Connect to stream telemetry</span>
                  )}
                </div>
                <MotorVisualizer
                  speedRadPerSec={telemetryLive ? motorState.speed : 0}
                  rpm={telemetryLive ? motorState.rpm : 0}
                  active={telemetryLive}
                  anomaly={telemetryLive ? motorState.anomaly : 'NORMAL'}
                />
                <div className="mb-8">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-sm font-medium text-muted-foreground">Motor Status</span>
                    <div
                      className={`status-led ${motorState.status !== 'Stop' ? 'active' : ''} ${
                        motorState.status === 'Error'
                          ? 'bg-destructive'
                          : motorState.status === 'Running'
                            ? 'bg-green-500'
                            : 'bg-muted'
                      }`}
                    />
                  </div>
                  <p className="text-2xl font-bold text-primary">
                    {telemetryLive ? motorState.status : '—'}
                  </p>
                </div>
                <div className="mb-8">
                  <p className="text-sm font-medium text-muted-foreground mb-2">Speed</p>
                  <div className="bg-secondary/50 rounded-lg p-4">
                    <p className="text-3xl font-mono font-bold text-accent">
                      {telemetryLive ? `${motorState.rpm.toFixed(0)} RPM` : '— RPM'}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {telemetryLive ? `${motorState.speed.toFixed(2)} rad/s` : '— rad/s'}
                    </p>
                  </div>
                </div>
                {renderAnomalyPanel()}
                <div className="pt-4 border-t border-border">
                  <p className="text-xs text-muted-foreground">
                    Last update:{' '}
                    {telemetryLive
                      ? new Date(motorState.timestamp).toLocaleTimeString()
                      : '—'}
                  </p>
                </div>
              </div>
            </div>
          </div>
        ) : !bluetoothSupported ? (
          <div className="max-w-2xl mx-auto bg-destructive/10 border border-destructive/20 rounded-xl p-8 text-center">
            <AlertCircle className="w-12 h-12 text-destructive mx-auto mb-4" />
            <h2 className="text-2xl font-bold text-foreground mb-2">Web Bluetooth Not Supported</h2>
            <p className="text-muted-foreground mb-4">
              This view has no Web Bluetooth API (Cursor Simple Browser and many embedded
              browsers do not). On Linux, open the app with the dedicated Chrome launcher
              so experimental Web Bluetooth flags are enabled:
            </p>
            <pre className="text-left text-sm bg-muted rounded-lg p-4 mb-4 overflow-x-auto">
{`./scripts/start-dev.sh          # Vite on :3000 if not already running
./scripts/start-chrome-linux.sh # Chrome with WebBluetooth flags`}
            </pre>
            <p className="text-muted-foreground mb-4">
              Use that Chrome window (profile under{" "}
              <code>~/.config/motor-ble-controller-chrome</code>), not Cursor&apos;s
              built-in browser. On Windows remotes, open system Chrome to{" "}
              <code>http://localhost:3000/motor-ble-controller/</code>.
            </p>
            <Button
              type="button"
              onClick={enterTestMode}
              className="bg-amber-500 hover:bg-amber-600 text-white"
            >
              <FlaskConical className="w-4 h-4 mr-2" />
              Open Test Mode instead
            </Button>
          </div>
        ) : (
          /* ——— Production UI ——— */
          <div className="grid lg:grid-cols-3 gap-8">
            {/* Left: Technology Stack */}
            <div className="lg:col-span-1">
              <div className="bg-white rounded-xl p-6 shadow-sm border border-border">
                <h2 className="text-lg font-bold text-primary mb-4">Technology Stack</h2>
                <div className="space-y-3">
                  <div className="flex items-start gap-3">
                    <Bluetooth className="w-5 h-5 text-accent flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="font-medium text-foreground">Bluetooth Connectivity</p>
                      <p className="text-xs text-muted-foreground">Web Bluetooth SPP</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <Zap className="w-5 h-5 text-accent flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="font-medium text-foreground">Motor Control</p>
                      <p className="text-xs text-muted-foreground">PWM Speed Regulation</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <CheckCircle2 className="w-5 h-5 text-accent flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="font-medium text-foreground">Anomaly Detection Active Sign</p>
                      <p className="text-xs text-muted-foreground">AI/ML Edge Processing</p>
                    </div>
                  </div>
                </div>

                {/* Connection Button */}
                <div className="mt-6 pt-6 border-t border-border">
                  {!connected ? (
                    <Button
                      onClick={connectBluetooth}
                      className="w-full tech-button bg-accent hover:bg-accent/90 text-accent-foreground"
                    >
                      <Bluetooth className="w-4 h-4 mr-2" />
                      Connect Device
                    </Button>
                  ) : (
                    <Button
                      onClick={disconnectBluetooth}
                      variant="outline"
                      className="w-full tech-button"
                    >
                      Disconnect
                    </Button>
                  )}
                </div>
              </div>
            </div>

            {/* Center: Control Panel */}
            <div className="lg:col-span-1">
              <div className="bg-white rounded-xl p-8 shadow-sm border border-border">
                <h2 className="text-lg font-bold text-primary mb-8 text-center">Fan Control</h2>

                <div className="space-y-4">
                  {/* Stop Button */}
                  <button
                    onClick={() => setMotorMode('stop')}
                    disabled={!connected}
                    className={`w-full tech-button py-4 rounded-xl font-semibold transition-all ${
                      currentMode === 'stop'
                        ? 'bg-gray-500 text-white shadow-lg'
                        : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                    } disabled:opacity-50 disabled:cursor-not-allowed`}
                  >
                    <span className="text-lg">⏹</span> Stop
                  </button>

                  {/* Low Speed Button */}
                  <button
                    onClick={() => setMotorMode('low')}
                    disabled={!connected}
                    className={`w-full tech-button py-4 rounded-xl font-semibold transition-all ${
                      currentMode === 'low'
                        ? 'bg-green-500 text-green-foreground shadow-lg'
                        : 'bg-green-100 text-green-700 hover:bg-green-200'
                    } disabled:opacity-50 disabled:cursor-not-allowed`}
                  >
                    <span className="text-lg">🌀</span> Low (50 rad/s)
                  </button>

                  {/* High Speed Button */}
                  <button
                    onClick={() => setMotorMode('high')}
                    disabled={!connected}
                    className={`w-full tech-button py-4 rounded-xl font-semibold transition-all ${
                      currentMode === 'high'
                        ? 'bg-accent text-accent-foreground shadow-lg'
                        : 'bg-accent/10 text-accent hover:bg-accent/20'
                    } disabled:opacity-50 disabled:cursor-not-allowed`}
                  >
                    <span className="text-lg">⚡</span> High (250 rad/s)
                  </button>

                  {/* Custom Speed */}
                  <div
                    className={`rounded-xl border p-4 transition-all ${
                      currentMode === 'custom'
                        ? 'border-primary bg-primary/5 shadow-sm'
                        : 'border-border bg-secondary/30'
                    }`}
                  >
                    <label
                      htmlFor="custom-speed"
                      className="mb-2 block text-sm font-medium text-foreground"
                    >
                      Custom speed (rad/s)
                    </label>
                    <div className="flex gap-2">
                      <input
                        id="custom-speed"
                        type="number"
                        min={MOTOR_SPEED_MIN_RAD_S}
                        max={MOTOR_SPEED_MAX_RAD_S}
                        step={1}
                        value={customSpeedInput}
                        onChange={(e) => setCustomSpeedInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            void setCustomSpeed();
                          }
                        }}
                        disabled={!connected}
                        className="w-full rounded-lg border border-border bg-white px-3 py-2 font-mono text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-50"
                        placeholder="e.g. 100"
                      />
                      <Button
                        onClick={() => void setCustomSpeed()}
                        disabled={!connected}
                        className="shrink-0 tech-button bg-primary hover:bg-primary/90 text-primary-foreground"
                      >
                        Set
                      </Button>
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">
                      Range {MOTOR_SPEED_MIN_RAD_S}–{MOTOR_SPEED_MAX_RAD_S} rad/s (M0 = stop)
                    </p>
                  </div>
                </div>

                {/* Auto-Shutoff Toggle — UI retained; feature not on device yet */}
                <div className="mt-8 pt-8 border-t border-border opacity-70">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-2">
                      <Power className="w-5 h-5 text-primary" />
                      <span className="font-medium text-foreground">Auto-Shutoff</span>
                    </div>
                    <button
                      type="button"
                      disabled
                      aria-disabled="true"
                      title="Not available on device yet"
                      className="relative inline-flex h-8 w-14 cursor-not-allowed items-center rounded-full bg-gray-300 opacity-60"
                    >
                      <span className="inline-block h-6 w-6 translate-x-1 transform rounded-full bg-white" />
                    </button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Auto-shutoff disabled — not available on device yet
                  </p>
                </div>
              </div>
            </div>

            {/* Right: Telemetry Display — driven by BLE notifications after connect */}
            <div className="lg:col-span-1">
              <div className="bg-white rounded-xl p-8 shadow-sm border border-border">
                <h2 className="text-lg font-bold text-primary mb-6 text-center">Real-Time Telemetry</h2>
                <div className="mb-6 flex items-center justify-center gap-2 text-xs font-medium">
                  {connected && telemetryLive ? (
                    <>
                      <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                      <span className="text-green-700">Live via BLE notify</span>
                    </>
                  ) : connected ? (
                    <>
                      <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                      <span className="text-amber-700">Waiting for device telemetry…</span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">Connect to stream telemetry</span>
                  )}
                </div>

                {/* Status Indicator */}
                <div className="mb-8">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-sm font-medium text-muted-foreground">Motor Status</span>
                    <div className={`status-led ${motorState.status !== 'Stop' ? 'active' : ''} ${
                      motorState.status === 'Error'
                        ? 'bg-destructive'
                        : motorState.status === 'Running'
                          ? 'bg-green-500'
                          : 'bg-muted'
                    }`} />
                  </div>
                  <p className="text-2xl font-bold text-primary">
                    {telemetryLive ? motorState.status : '—'}
                  </p>
                </div>

                {/* Speed Display */}
                <div className="mb-8">
                  <p className="text-sm font-medium text-muted-foreground mb-2">Speed</p>
                  <div className="bg-secondary/50 rounded-lg p-4">
                    <p className="text-3xl font-mono font-bold text-accent">
                      {telemetryLive ? `${motorState.rpm.toFixed(0)} RPM` : '— RPM'}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {telemetryLive ? `${motorState.speed.toFixed(2)} rad/s` : '— rad/s'}
                    </p>
                  </div>
                </div>

                {renderAnomalyPanel()}

                {/* Last Update */}
                <div className="pt-4 border-t border-border">
                  <p className="text-xs text-muted-foreground">
                    Last update:{' '}
                    {telemetryLive
                      ? new Date(motorState.timestamp).toLocaleTimeString()
                      : '—'}
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Error Message */}
        {error && (
          <div className="mt-8 max-w-2xl mx-auto bg-destructive/10 border border-destructive/20 rounded-lg p-4 flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-destructive flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-medium text-destructive">Error</p>
              <p className="text-sm text-destructive/80">{error}</p>
            </div>
          </div>
        )}
      </main>

      {/* Debug Console */}
      <DebugConsole messages={debugMessages} onClear={clearDebugMessages} />

      {/* Footer */}
      <footer className="border-t border-border bg-white/50 backdrop-blur-sm mt-12">
        <div className="container py-6 text-center text-sm text-muted-foreground">
          <p>© 2025 Silicon Labs. Web Bluetooth Fan Controller Demo v1.0.0</p>
        </div>
      </footer>
    </div>
  );
}
