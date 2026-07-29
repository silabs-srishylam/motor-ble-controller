import { useState, useRef } from 'react';
import { Bluetooth, AlertCircle, CheckCircle2, Zap, Power } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DebugConsole, type DebugMessage } from '@/components/DebugConsole';
import { BLE_PROFILES, BLE_SERVICE_UUIDS } from '@/lib/ble-profiles';
import { writeBleCharacteristic } from '@/lib/ble-write';
import { TelemetryStreamParser, type MotorTelemetry } from '@/lib/telemetry-parser';

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

type MotorMode = 'stop' | 'low' | 'high';

/**
 * FanController Component
 * 
 * Web Bluetooth SPP interface for Silicon Labs MG24 motor control demo
 * Demonstrates integration of:
 * - Bluetooth Connectivity (Web Bluetooth SPP)
 * - Motor Control (PWM-based speed regulation)
 * - Anomaly Detection (AI/ML edge processing)
 * - Auto-shutoff feature control
 */
export default function FanController() {
  const [connected, setConnected] = useState(false);
  const [currentMode, setCurrentMode] = useState<MotorMode>('stop');
  const [motorState, setMotorState] = useState<MotorTelemetry>({
    status: 'Stop',
    speed: 0,
    rpm: 0,
    anomalyPercentage: 0,
    anomalyDetected: false,
    anomalyActive: false,
    timestamp: Date.now(),
  });
  const [connectionStatus, setConnectionStatus] = useState<string>('Disconnected');
  const [error, setError] = useState<string | null>(null);
  const [autoShutoffEnabled, setAutoShutoffEnabled] = useState(false);
  const [debugMessages, setDebugMessages] = useState<DebugMessage[]>([]);
  /** True after at least one full telemetry frame arrived over BLE notifications. */
  const [telemetryLive, setTelemetryLive] = useState(false);

  const characteristicRef = useRef<any>(null);
  const deviceRef = useRef<BluetoothDevice | null>(null);
  const telemetryParserRef = useRef<TelemetryStreamParser>(new TelemetryStreamParser());
  const debugMessageIdRef = useRef(0);
  /** True while the user (or UI) is intentionally tearing down the link. */
  const intentionalDisconnectRef = useRef(false);
  /** Stable listener refs so handlers always see the latest logic. */
  const onGattDisconnectedRef = useRef<() => void>(() => {});
  const onCharacteristicChangeRef = useRef<(event: Event) => void>(() => {});
  const gattDisconnectedListener = useRef(() => {
    onGattDisconnectedRef.current();
  }).current;
  const characteristicChangeListener = useRef((event: Event) => {
    onCharacteristicChangeRef.current(event);
  }).current;

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
    setDebugMessages((prev) => [...prev.slice(-99), message]); // Keep last 100 messages
  };

  /**
   * Clear debug messages
   */
  const clearDebugMessages = () => {
    setDebugMessages([]);
    debugMessageIdRef.current = 0;
  };

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
   */
  const clearConnectionState = () => {
    deviceRef.current = null;
    characteristicRef.current = null;
    telemetryParserRef.current.reset();
    setConnected(false);
    setConnectionStatus('Disconnected');
    setCurrentMode('stop');
    setTelemetryLive(false);
    setMotorState({
      status: 'Stop',
      speed: 0,
      rpm: 0,
      anomalyPercentage: 0,
      anomalyDetected: false,
      anomalyActive: false,
      timestamp: Date.now(),
    });
  };

  /**
   * Handle unexpected GATT disconnect (device out of range, firmware reset, etc.)
   */
  const handleGattDisconnected = () => {
    const wasIntentional = intentionalDisconnectRef.current;
    intentionalDisconnectRef.current = false;
    clearConnectionState();
    if (!wasIntentional) {
      setError('BLE connection lost. Reconnect to continue.');
    }
  };
  onGattDisconnectedRef.current = handleGattDisconnected;

  /**
   * Connect to Bluetooth device via Web Bluetooth API
   */
  const connectBluetooth = async () => {
    try {
      setError(null);
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
      setMotorState({
        status: 'Stop',
        speed: 0,
        rpm: 0,
        anomalyPercentage: 0,
        anomalyDetected: false,
        anomalyActive: false,
        timestamp: Date.now(),
      });

      // Telemetry updates from characteristicvaluechanged as Motor: frames arrive.
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Connection failed';
      setError(errorMsg);
      setConnectionStatus('Disconnected');
      setConnected(false);
    }
  };

  /**
   * Apply parsed telemetry from BLE notifications to the Real-Time Telemetry panel.
   */
  const applyTelemetry = (telemetry: MotorTelemetry) => {
    setTelemetryLive(true);
    setMotorState(telemetry);

    const absSpeed = Math.abs(telemetry.speed);
    if (telemetry.status === 'Stop' || absSpeed < 1) {
      setCurrentMode('stop');
    } else if (absSpeed >= 150) {
      setCurrentMode('high');
    } else {
      setCurrentMode('low');
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
    const characteristic = event.target as any;
    const value = characteristic.value as DataView | undefined;
    if (value) {
      // DataView may share a larger ArrayBuffer — slice the exact GATT payload.
      const rawData = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);

      const telemetryFrames = telemetryParserRef.current.feed(rawData);
      for (const telemetry of telemetryFrames) {
        applyTelemetry(telemetry);
      }

      // Log complete frames when available; otherwise show the raw chunk.
      if (telemetryFrames.length > 0) {
        for (const telemetry of telemetryFrames) {
          addDebugMessage(
            'received',
            `Motor: ${telemetry.status}  Speed: ${telemetry.speed.toFixed(2)} Anomaly: ${telemetry.anomalyPercentage}%`
          );
        }
      } else {
        const dataStr = new TextDecoder().decode(rawData);
        if (dataStr.trim()) {
          addDebugMessage('received', dataStr.trim(), rawData);
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
      setError('Not connected to device');
      return;
    }

    try {
      const encoder = new TextEncoder();
      const data = encoder.encode(command + '\n');
      addDebugMessage('sent', command);
      await writeBleCharacteristic(characteristicRef.current, data);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to send command';
      setError(errorMsg);
      if (errorMsg.includes('disconnected') || errorMsg.includes('GATT')) {
        setConnected(false);
        setConnectionStatus('Disconnected');
        characteristicRef.current = null;
      }
    }
  };

  /**
   * Control motor mode — sends the command only.
   * Real-Time Telemetry is updated solely from BLE notifications after connect.
   */
  const setMotorMode = async (mode: MotorMode) => {
    let command = '';

    switch (mode) {
      case 'stop':
        command = 'M0';
        break;
      case 'low':
        command = 'M50';
        break;
      case 'high':
        command = 'M250';
        break;
    }

    // Highlight the pressed control; telemetry panel follows device notify stream.
    setCurrentMode(mode);
    await sendCommand(command);
  };

  /**
   * Toggle auto-shutoff feature
   */
  const toggleAutoShutoff = async () => {
    const newState = !autoShutoffEnabled;
    const command = newState ? 'AOFF1' : 'AOFF0';

    try {
      await sendCommand(command);
      setAutoShutoffEnabled(newState);
    } catch (err) {
      setError(`Failed to ${newState ? 'enable' : 'disable'} auto-shutoff`);
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

    setError(null);
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
        {!bluetoothSupported ? (
          <div className="max-w-2xl mx-auto bg-destructive/10 border border-destructive/20 rounded-xl p-8 text-center">
            <AlertCircle className="w-12 h-12 text-destructive mx-auto mb-4" />
            <h2 className="text-2xl font-bold text-foreground mb-2">Web Bluetooth Not Supported</h2>
            <p className="text-muted-foreground mb-4">
              Your browser does not support the Web Bluetooth API. Please use Chrome, Edge, or Opera on a device with Bluetooth hardware.
            </p>
          </div>
        ) : (
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
                </div>

                {/* Auto-Shutoff Toggle */}
                <div className="mt-8 pt-8 border-t border-border">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-2">
                      <Power className="w-5 h-5 text-primary" />
                      <span className="font-medium text-foreground">Auto-Shutoff</span>
                    </div>
                    <button
                      onClick={toggleAutoShutoff}
                      disabled={!connected}
                      className={`relative inline-flex h-8 w-14 items-center rounded-full transition-colors ${
                        autoShutoffEnabled ? 'bg-accent' : 'bg-gray-300'
                      } disabled:opacity-50 disabled:cursor-not-allowed`}
                    >
                      <span
                        className={`inline-block h-6 w-6 transform rounded-full bg-white transition-transform ${
                          autoShutoffEnabled ? 'translate-x-7' : 'translate-x-1'
                        }`}
                      />
                    </button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {autoShutoffEnabled ? 'Auto-shutoff enabled' : 'Auto-shutoff disabled'}
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

                {/* Anomaly Detection */}
                <div className="mb-4">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-sm font-medium text-muted-foreground">Anomaly Detection</span>
                    <div className={`status-led ${motorState.anomalyDetected ? 'active' : ''} ${
                      !telemetryLive || !motorState.anomalyActive ? 'bg-muted' :
                        motorState.anomalyDetected ? 'bg-yellow-500' : 'bg-green-500'
                    }`} />
                  </div>
                  
                  {/* Anomaly Meter Bar */}
                  <div className="mb-3">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-2xl font-mono font-bold text-foreground">
                        {telemetryLive ? `${motorState.anomalyPercentage}%` : '—'}
                      </span>
                      <span className="text-xs font-medium text-muted-foreground">
                        {!telemetryLive
                          ? 'Pending'
                          : motorState.anomalyPercentage < 30
                            ? 'Normal'
                            : motorState.anomalyPercentage < 70
                              ? 'Warning'
                              : 'Critical'}
                      </span>
                    </div>
                    
                    {/* Progress Bar */}
                    <div className="w-full h-3 bg-gray-200 rounded-full overflow-hidden">
                      <div
                        className={`h-full transition-all duration-300 ${
                          motorState.anomalyPercentage < 30
                            ? 'bg-green-500'
                            : motorState.anomalyPercentage < 70
                              ? 'bg-yellow-500'
                              : 'bg-red-500'
                        }`}
                        style={{
                          width: `${telemetryLive ? motorState.anomalyPercentage : 0}%`,
                        }}
                      />
                    </div>
                  </div>
                  
                  <p className="text-xs text-muted-foreground">
                    {!telemetryLive
                      ? 'Telemetry starts when BLE notifications deliver Motor: frames'
                      : motorState.anomalyDetected
                        ? '⚠️ Anomaly Detected'
                        : '✓ Normal Operation'}
                  </p>
                </div>

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
