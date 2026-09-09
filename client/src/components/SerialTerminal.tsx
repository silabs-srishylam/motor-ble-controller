import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { Cable, Download, Send, Trash2, Unplug } from 'lucide-react';
import { Button } from '@/components/ui/button';

declare global {
  interface Navigator {
    serial?: Serial;
  }
  interface Serial {
    requestPort(options?: SerialPortRequestOptions): Promise<SerialPort>;
    getPorts(): Promise<SerialPort[]>;
  }
  interface SerialPortRequestOptions {
    filters?: SerialPortFilter[];
  }
  interface SerialPortFilter {
    usbVendorId?: number;
    usbProductId?: number;
  }
  interface SerialPort {
    readable: ReadableStream<Uint8Array> | null;
    writable: WritableStream<Uint8Array> | null;
    open(options: SerialOptions): Promise<void>;
    close(): Promise<void>;
    getInfo(): { usbVendorId?: number; usbProductId?: number };
  }
  interface SerialOptions {
    baudRate: number;
    dataBits?: 7 | 8;
    stopBits?: 1 | 2;
    parity?: 'none' | 'even' | 'odd';
    bufferSize?: number;
    flowControl?: 'none' | 'hardware';
  }
}

const BAUD_RATES = [9600, 57600, 115200, 230400, 460800, 921600] as const;
const LOG_MAX = 2000;

interface LogLine {
  text: string;
  t: number;
}

interface SerialTerminalProps {
  /** Panel title, e.g. SiWG917 Serial */
  title: string;
  /** Default baud (Silicon Labs VCOM is commonly 115200) */
  defaultBaudRate?: number;
  /** Extra classes for the outer shell */
  className?: string;
  /** Optional inline style (e.g. match Telemetry column height) */
  style?: CSSProperties;
}

function formatLogTime(t: number) {
  return new Date(t).toLocaleTimeString(undefined, {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  } as Intl.DateTimeFormatOptions);
}

/** True for common firmware warning tags: [W], [WARN], WARNING, etc. */
function isWarningLine(text: string) {
  return /\[W(?:RN|ARN(?:ING)?)?\]|\bWARN(?:ING)?\b/i.test(text);
}

function formatDisplayLine(line: LogLine, showTimestamp: boolean) {
  return showTimestamp ? `[${formatLogTime(line.t)}] ${line.text}` : line.text;
}

/**
 * Serial log viewer via Web Serial API (Chrome / Edge).
 * Used to stream device console output (e.g. SiWG917 VCOM).
 */
export function SerialTerminal({
  title,
  defaultBaudRate = 115200,
  className = '',
  style,
}: SerialTerminalProps) {
  const [connected, setConnected] = useState(false);
  const [baudRate, setBaudRate] = useState(defaultBaudRate);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [commandInput, setCommandInput] = useState('');
  const [showTimestamp, setShowTimestamp] = useState(false);
  /** When true, show only warning-level lines. */
  const [filterWarning, setFilterWarning] = useState(false);

  const portRef = useRef<SerialPort | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const keepReadingRef = useRef(false);
  const bufferRef = useRef('');
  const scrollRef = useRef<HTMLDivElement>(null);
  /** Follow newest logs unless the user scrolls up. */
  const autoScrollRef = useRef(true);
  const disconnectRef = useRef<() => Promise<void>>(async () => {});

  const serialSupported = typeof navigator !== 'undefined' && !!navigator.serial;

  const appendLines = useCallback((texts: string[]) => {
    if (texts.length === 0) {
      return;
    }
    const now = Date.now();
    setLines((prev) => {
      const next = [...prev, ...texts.map((text) => ({ text, t: now }))];
      return next.length > LOG_MAX ? next.slice(-LOG_MAX) : next;
    });
  }, []);

  const appendText = useCallback(
    (chunk: string) => {
      bufferRef.current += chunk;
      const parts = bufferRef.current.split(/\r\n|\n|\r/);
      bufferRef.current = parts.pop() ?? '';
      const fresh = parts.filter((p) => p.length > 0);
      appendLines(fresh);
    },
    [appendLines]
  );

  const disconnect = useCallback(async () => {
    keepReadingRef.current = false;
    try {
      await readerRef.current?.cancel();
    } catch {
      // ignore
    }
    readerRef.current = null;
    try {
      await portRef.current?.close();
    } catch {
      // ignore
    }
    portRef.current = null;
    setCommandInput('');
    setConnected(false);
  }, []);
  disconnectRef.current = disconnect;

  const sendCommand = useCallback(async () => {
    const cmd = commandInput.trim();
    const port = portRef.current;
    if (!cmd || !port?.writable) {
      return;
    }

    setError(null);
    try {
      const writer = port.writable.getWriter();
      try {
        await writer.write(new TextEncoder().encode(`${cmd}\n`));
      } finally {
        writer.releaseLock();
      }
      appendLines([`> ${cmd}`]);
      setCommandInput('');
      autoScrollRef.current = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to send command';
      setError(msg);
    }
  }, [appendLines, commandInput]);

  const readLoop = useCallback(
    async (port: SerialPort) => {
      if (!port.readable) {
        return;
      }
      keepReadingRef.current = true;
      const decoder = new TextDecoder();
      const reader = port.readable.getReader();
      readerRef.current = reader;

      try {
        while (keepReadingRef.current) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          if (value) {
            appendText(decoder.decode(value, { stream: true }));
          }
        }
      } catch (err) {
        if (keepReadingRef.current) {
          const msg = err instanceof Error ? err.message : 'Serial read failed';
          setError(msg);
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // ignore
        }
        readerRef.current = null;
      }
    },
    [appendText]
  );

  const connect = useCallback(async () => {
    if (!navigator.serial) {
      setError('Web Serial is not supported. Use Chrome or Edge.');
      return;
    }
    setError(null);
    try {
      const port = await navigator.serial.requestPort();
      await port.open({ baudRate, dataBits: 8, stopBits: 1, parity: 'none' });
      portRef.current = port;
      setConnected(true);
      autoScrollRef.current = true;
      appendLines([`--- Connected @ ${baudRate} baud ---`]);
      void readLoop(port);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to open serial port';
      if (!/No port selected|user cancelled|AbortError/i.test(msg)) {
        setError(msg);
      }
      await disconnect();
    }
  }, [appendLines, baudRate, disconnect, readLoop]);

  useEffect(() => {
    return () => {
      void disconnectRef.current();
    };
  }, []);

  const visibleLines = useMemo(() => {
    const filtered = filterWarning ? lines.filter((l) => isWarningLine(l.text)) : lines;
    return filtered.map((l) => formatDisplayLine(l, showTimestamp));
  }, [filterWarning, lines, showTimestamp]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !autoScrollRef.current) {
      return;
    }
    el.scrollTop = el.scrollHeight;
  }, [visibleLines]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    autoScrollRef.current = distanceFromBottom < 48;
  };

  const exportLog = useCallback(() => {
    if (visibleLines.length === 0) {
      return;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const blob = new Blob([visibleLines.join('\n') + '\n'], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${slug || 'serial'}-log-${stamp}.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [title, visibleLines]);

  return (
    <div
      className={`bg-slate-950 text-slate-100 rounded-xl border border-slate-700 shadow-sm overflow-hidden flex flex-col min-h-0 h-full ${className}`}
      style={style}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 bg-slate-900 border-b border-slate-700 shrink-0">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              className={`w-2 h-2 rounded-full shrink-0 ${
                connected ? 'bg-emerald-400 animate-pulse' : 'bg-slate-500'
              }`}
            />
            <h3 className="text-sm font-semibold truncate">{title}</h3>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-slate-300">
            <label className="inline-flex items-center gap-1.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={showTimestamp}
                onChange={(e) => setShowTimestamp(e.target.checked)}
                className="rounded border-slate-500 bg-slate-800 text-cyan-500 focus:ring-cyan-500/40"
              />
              Timestamp
            </label>
            <label
              className="inline-flex items-center gap-1.5 cursor-pointer select-none"
              title="Show only warning lines ([W], WARN, …)"
            >
              <input
                type="checkbox"
                checked={filterWarning}
                onChange={(e) => setFilterWarning(e.target.checked)}
                className="rounded border-slate-500 bg-slate-800 text-cyan-500 focus:ring-cyan-500/40"
              />
              Filter Warning
            </label>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={baudRate}
            disabled={connected}
            onChange={(e) => setBaudRate(Number(e.target.value))}
            className="h-8 rounded-md border border-slate-600 bg-slate-800 px-2 text-xs text-slate-100 disabled:opacity-50"
            aria-label={`${title} baud rate`}
          >
            {BAUD_RATES.map((rate) => (
              <option key={rate} value={rate}>
                {rate}
              </option>
            ))}
          </select>
          {connected ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void disconnect()}
              className="h-8 border-slate-600 bg-slate-800 text-slate-100 hover:bg-slate-700"
            >
              <Unplug className="w-3.5 h-3.5 mr-1" />
              Close
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              onClick={() => void connect()}
              disabled={!serialSupported}
              className="h-8 bg-cyan-600 hover:bg-cyan-500 text-white"
            >
              <Cable className="w-3.5 h-3.5 mr-1" />
              Open
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={exportLog}
            disabled={visibleLines.length === 0}
            className="h-8 text-slate-300 hover:text-white hover:bg-slate-800 disabled:opacity-40"
            title="Export log"
          >
            <Download className="w-3.5 h-3.5" />
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              autoScrollRef.current = true;
              setLines([]);
            }}
            className="h-8 text-slate-300 hover:text-white hover:bg-slate-800"
            title="Clear"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      {!serialSupported && (
        <p className="px-3 py-2 text-xs text-amber-300 bg-amber-950/40 border-b border-amber-900/50 shrink-0">
          Web Serial requires Chrome or Edge over HTTPS / localhost.
        </p>
      )}
      {error && (
        <p className="px-3 py-2 text-xs text-red-300 bg-red-950/40 border-b border-red-900/40 shrink-0">
          {error}
        </p>
      )}

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 basis-0 overflow-y-auto overscroll-contain [overflow-anchor:none] px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all"
      >
        {lines.length === 0 ? (
          <p className="text-slate-500">
            Click Open and select the USB serial port (e.g. ttyACM / COM).
          </p>
        ) : visibleLines.length === 0 ? (
          <p className="text-slate-500">No warning lines to show.</p>
        ) : (
          <pre className="m-0 text-emerald-300/90">{visibleLines.join('\n')}</pre>
        )}
      </div>

      <form
        className="flex shrink-0 gap-2 border-t border-slate-700 bg-slate-900 px-3 py-2"
        onSubmit={(e) => {
          e.preventDefault();
          void sendCommand();
        }}
      >
        <input
          type="text"
          value={commandInput}
          onChange={(e) => setCommandInput(e.target.value)}
          disabled={!connected}
          placeholder={connected ? 'e.g. motor telemetry' : 'Open serial to send commands'}
          className="min-w-0 flex-1 rounded-md border border-slate-600 bg-slate-800 px-2 py-1.5 font-mono text-xs text-slate-100 placeholder:text-slate-500 disabled:opacity-50"
          aria-label={`${title} command input`}
        />
        <Button
          type="submit"
          size="sm"
          disabled={!connected || !commandInput.trim()}
          className="h-8 shrink-0 bg-cyan-600 hover:bg-cyan-500 text-white disabled:opacity-50"
        >
          <Send className="w-3.5 h-3.5 mr-1" />
          Send
        </Button>
      </form>
    </div>
  );
}
