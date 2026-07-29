export interface BleCharacteristicLike {
  properties?: {
    read?: boolean;
    write?: boolean;
    writeWithoutResponse?: boolean;
    notify?: boolean;
  };
  writeValue(value: BufferSource): Promise<void>;
  writeValueWithoutResponse?(value: BufferSource): Promise<void>;
}

export type BleWriteMode = 'withResponse' | 'withoutResponse';

/**
 * Write to a BLE characteristic using the mode the device supports.
 * SPP/UART characteristics often only accept write-without-response;
 * using writeValue() on those fails on Linux with "GATT operation failed".
 */
export async function writeBleCharacteristic(
  characteristic: BleCharacteristicLike,
  data: BufferSource
): Promise<BleWriteMode> {
  const canWriteWithoutResponse =
    characteristic.properties?.writeWithoutResponse !== false &&
    typeof characteristic.writeValueWithoutResponse === 'function';
  const canWriteWithResponse = characteristic.properties?.write !== false;

  if (characteristic.properties?.writeWithoutResponse && canWriteWithoutResponse) {
    await characteristic.writeValueWithoutResponse!(data);
    return 'withoutResponse';
  }

  if (characteristic.properties?.write && canWriteWithResponse) {
    await characteristic.writeValue(data);
    return 'withResponse';
  }

  // Properties unavailable: try without-response first (typical for SPP on Linux)
  if (canWriteWithoutResponse) {
    try {
      await characteristic.writeValueWithoutResponse!(data);
      return 'withoutResponse';
    } catch {
      // Fall back to write with response
    }
  }

  await characteristic.writeValue(data);
  return 'withResponse';
}

export function describeCharacteristicProperties(
  characteristic: BleCharacteristicLike
): string {
  const props = characteristic.properties;
  if (!props) return 'properties unknown';

  const enabled = Object.entries(props)
    .filter(([, value]) => value)
    .map(([key]) => key);

  return enabled.length > 0 ? enabled.join(', ') : 'none';
}
