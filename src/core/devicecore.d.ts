// The register-level simulator is shared, unchanged, with the website's Device Lab (site/assets/devicecore.js). It is plain JavaScript.
declare module '*devicecore.js' {
  export const core: (data: { devices: unknown[] }) => {
    makeDevice(id: string, addr: number, inputs?: Record<string, number>): SimDevice;
  };
  export interface SimDevice {
    addr: number;
    inputs: Record<string, number>;
    write(bytes: number[]): { notes: string[]; warns: string[] };
    read(n: number): { bytes: number[]; notes: string[]; warns: string[] };
    advance(ms: number): void;
    setInput(name: string, value: number): void;
    snapshot(): { addr: string; name: string; access: string; value: string }[];
  }
}
