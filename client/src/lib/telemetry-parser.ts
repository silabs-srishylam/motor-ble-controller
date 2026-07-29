/**
 * Telemetry Parser
 *
 * Parses telemetry messages from Silicon Labs motor control boards.
 *
 * Message format:
 * "Motor: <status>  Speed: <speed> Anomaly: <percentage>%\n"
 *
 * BLE SPP notifies are often chunked (~20 bytes). Firmware may also abort a
 * multi-chunk send when a new command arrives, so the stream parser must
 * recover partial / interleaved fragments — not only clean newline lines.
 */

export interface MotorTelemetry {
  status: 'Running' | 'Stop' | 'Error';
  speed: number; // rad/sec (signed from firmware; UI uses magnitude for RPM)
  rpm: number; // calculated from |speed|
  anomalyPercentage: number; // 0-100%
  anomalyDetected: boolean; // true if anomaly > 50%
  anomalyActive: boolean; // true if anomaly is currently active
  timestamp: number;
}

/** Complete telemetry frame embedded anywhere in a BLE stream chunk sequence. */
const TELEMETRY_FRAME_RE =
  /Motor:\s*(Running|Stop|Error)\s+Speed:\s*([-+]?\d+(?:\.\d+)?)\s+Anomaly:\s*(\d+)\s*%(?:\s+mode:\s*(imu|audio))?/i;

/**
 * Parse telemetry message from firmware
 * Format: "Motor: <status>  Speed: <speed> Anomaly: <percentage>% [mode: <imu|audio>]"
 *
 * @param message - Raw telemetry message string
 * @returns Parsed telemetry data or null if invalid
 */
export function parseTelemetry(message: string): MotorTelemetry | null {
  try {
    const line = message.trim();
    const match = line.match(TELEMETRY_FRAME_RE);

    if (!match) {
      console.warn('[Telemetry] Message does not match expected format:', line);
      return null;
    }

    const status = match[1] as 'Running' | 'Stop' | 'Error';
    const speed = parseFloat(match[2]);
    const anomalyPercentage = parseInt(match[3], 10);
    const mode = match[4] ? (match[4].toLowerCase() as 'imu' | 'audio') : undefined;

    if (!['Running', 'Stop', 'Error'].includes(status)) {
      console.warn('[Telemetry] Invalid status:', status);
      return null;
    }

    // Firmware reports signed rad/s; reject only out-of-range magnitudes.
    if (isNaN(speed) || Math.abs(speed) > 300) {
      console.warn('[Telemetry] Invalid speed:', speed);
      return null;
    }

    if (isNaN(anomalyPercentage) || anomalyPercentage < 0 || anomalyPercentage > 100) {
      console.warn('[Telemetry] Invalid anomaly percentage:', anomalyPercentage);
      return null;
    }

    const rpm = (Math.abs(speed) * 60) / (2 * Math.PI);
    const anomalyDetected = anomalyPercentage > 50;
    const anomalyActive = mode === 'imu';

    return {
      status,
      speed,
      rpm,
      anomalyPercentage,
      anomalyDetected,
      anomalyActive,
      timestamp: Date.now(),
    };
  } catch (error) {
    console.error('[Telemetry] Parse error:', error);
    return null;
  }
}

/**
 * Streaming telemetry parser for handling chunked Bluetooth notifications.
 * Buffers incomplete fragments and extracts every complete Motor:/Anomaly frame.
 */
export class TelemetryStreamParser {
  private buffer: string = '';

  /**
   * Feed data into the parser
   * @param data - Incoming data as string, Uint8Array, or DataView
   * @returns Array of parsed telemetry frames
   */
  feed(data: string | Uint8Array | DataView | ArrayBuffer): MotorTelemetry[] {
    const frames: MotorTelemetry[] = [];
    const str = decodeBlePayload(data).replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    this.buffer += str;

    const re = new RegExp(TELEMETRY_FRAME_RE.source, 'gi');
    let match: RegExpExecArray | null;
    let lastEnd = 0;

    while ((match = re.exec(this.buffer)) !== null) {
      const telemetry = parseTelemetry(match[0]);
      if (telemetry) {
        frames.push(telemetry);
      }
      lastEnd = match.index + match[0].length;
    }

    if (lastEnd > 0) {
      this.buffer = this.buffer.slice(lastEnd);
    }

    // Drop leading non-telemetry junk; keep a short tail for split tokens ("Mot"+"or:").
    const motorIdx = this.buffer.indexOf('Motor:');
    if (motorIdx > 0) {
      this.buffer = this.buffer.slice(motorIdx);
    } else if (motorIdx < 0 && this.buffer.length > 64) {
      this.buffer = this.buffer.slice(-16);
    } else if (this.buffer.length > 512) {
      this.buffer = this.buffer.slice(-256);
    }

    return frames;
  }

  /**
   * Reset the parser state
   */
  reset(): void {
    this.buffer = '';
  }

  /**
   * Get any remaining buffered data
   */
  getBuffer(): string {
    return this.buffer;
  }
}

function decodeBlePayload(data: string | Uint8Array | DataView | ArrayBuffer): string {
  if (typeof data === 'string') {
    return data;
  }
  if (data instanceof Uint8Array) {
    return new TextDecoder().decode(data);
  }
  if (data instanceof DataView) {
    return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  return new TextDecoder().decode(new Uint8Array(data));
}

/**
 * Create a test telemetry message for development
 */
export function createTestTelemetry(
  status: 'Running' | 'Stop' | 'Error' = 'Stop',
  speed: number = 0,
  anomalyPercentage: number = 0
): string {
  return `Motor: ${status}  Speed: ${speed.toFixed(2)} Anomaly: ${anomalyPercentage}%\n`;
}

/**
 * Validate telemetry message format
 */
export function isValidTelemetryFormat(message: string): boolean {
  return TELEMETRY_FRAME_RE.test(message.trim());
}
