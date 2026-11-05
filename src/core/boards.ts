import registry from './boards.json';

export type Toolchain = 'platformio' | 'arduino-cli' | 'esp-idf';

export interface BoardDoc {
  title: string;
  url: string;
}

export interface Board {
  id: string;
  name: string;
  vendor: string;
  mcu: string;
  arch: string;
  toolchains: Toolchain[];
  pioBoard?: string;
  fqbn?: string;
  baud: number;
  docs: BoardDoc[];
  svd?: string; // CMSIS-SVD register map (authoritative for addresses/bit fields)
}

// The registry is data: boards.json, shape in boards.schema.json, checked by test/unit.test.ts.
// Doc links are starting points only. They are HEAD-checked at runtime (verifyUrl)
// and nothing from them is trusted until it has been indexed into the evidence ledger.
export const BOARDS: Board[] = (registry as { boards: Board[] }).boards;

export const findBoard = (id?: string): Board | undefined => BOARDS.find((b) => b.id === id);
