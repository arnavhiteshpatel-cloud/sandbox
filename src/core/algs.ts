/**
 * Algorithm libraries. Every case's state is *derived from its algorithm* (case = inverse
 * of the alg applied to a solved cube), and unit tests verify that each algorithm preserves
 * F2L, that OLL algs orient and PLL algs only permute the last layer, and that all cases
 * are pairwise distinct. Diagrams are therefore always consistent with the algorithms.
 */

export interface AlgCase {
  id: string;
  set: "OLL" | "PLL" | string;
  name: string;
  group: string;
  algs: string[];
}

const oll = (n: number, group: string, ...algs: string[]): AlgCase => ({ id: `OLL${n}`, set: "OLL", name: `OLL ${n}`, group, algs });
const pll = (name: string, group: string, ...algs: string[]): AlgCase => ({ id: `PLL-${name}`, set: "PLL", name: `${name} perm`, group, algs });

export const OLL: AlgCase[] = [
  oll(1, "Dot", "R U2 R2 F R F' U2 R' F R F'"),
  oll(2, "Dot", "F R U R' U' F' f R U R' U' f'"),
  oll(3, "Dot", "f R U R' U' f' U' F R U R' U' F'"),
  oll(4, "Dot", "f R U R' U' f' U F R U R' U' F'"),
  oll(5, "Square", "r' U2 R U R' U r"),
  oll(6, "Square", "r U2 R' U' R U' r'"),
  oll(7, "Small lightning", "r U R' U R U2 r'"),
  oll(8, "Small lightning", "l' U' L U' L' U2 l"),
  oll(9, "Fish", "R U R' U' R' F R2 U R' U' F'"),
  oll(10, "Fish", "R U R' U R' F R F' R U2 R'"),
  oll(11, "Small lightning", "r U R' U R' F R F' R U2 r'"),
  oll(12, "Small lightning", "M' R' U' R U' R' U2 R U' R r'"),
  oll(13, "Knight move", "r U' r' U' r U r' F' U F"),
  oll(14, "Knight move", "R' F R U R' F' R F U' F'"),
  oll(15, "Knight move", "r' U' r R' U' R U r' U r"),
  oll(16, "Knight move", "r U r' R U R' U' r U' r'"),
  oll(17, "Dot", "R U R' U R' F R F' U2 R' F R F'"),
  oll(18, "Dot", "r U R' U R U2 r2 U' R U' R' U2 r"),
  oll(19, "Dot", "r' R U R U R' U' M' R' F R F'"),
  oll(20, "Dot", "r U R' U' M2 U R U' R' U' M'"),
  oll(21, "Cross", "R U2 R' U' R U R' U' R U' R'"),
  oll(22, "Cross", "R U2 R2 U' R2 U' R2 U2 R"),
  oll(23, "Cross", "R2 D' R U2 R' D R U2 R"),
  oll(24, "Cross", "r U R' U' r' F R F'"),
  oll(25, "Cross", "F' r U R' U' r' F R"),
  oll(26, "Cross", "R U2 R' U' R U' R'"),
  oll(27, "Cross", "R U R' U R U2 R'"),
  oll(28, "Corners oriented", "r U R' U' r' R U R U' R'"),
  oll(29, "Awkward", "R U R' U' R U' R' F' U' F R U R'"),
  oll(30, "Awkward", "F R' F R2 U' R' U' R U R' F2"),
  oll(31, "P shape", "R' U' F U R U' R' F' R"),
  oll(32, "P shape", "L U F' U' L' U L F L'"),
  oll(33, "T shape", "R U R' U' R' F R F'"),
  oll(34, "C shape", "R U R2 U' R' F R U R U' F'"),
  oll(35, "Fish", "R U2 R2 F R F' R U2 R'"),
  oll(36, "W shape", "L' U' L U' L' U L U L F' L' F"),
  oll(37, "Fish", "F R' F' R U R U' R'"),
  oll(38, "W shape", "R U R' U R U' R' U' R' F R F'"),
  oll(39, "Big lightning", "L F' L' U' L U F U' L'"),
  oll(40, "Big lightning", "R' F R U R' U' F' U R"),
  oll(41, "Awkward", "R U R' U R U2 R' F R U R' U' F'"),
  oll(42, "Awkward", "R' U' R U' R' U2 R F R U R' U' F'"),
  oll(43, "P shape", "F' U' L' U L F"),
  oll(44, "P shape", "F U R U' R' F'"),
  oll(45, "T shape", "F R U R' U' F'"),
  oll(46, "C shape", "R' U' R' F R F' U R"),
  oll(47, "L shape", "R' U' R' F R F' R' F R F' U R"),
  oll(48, "L shape", "F R U R' U' R U R' U' F'"),
  oll(49, "L shape", "r U' r2 U r2 U r2 U' r"),
  oll(50, "L shape", "r' U r2 U' r2 U' r2 U r'"),
  oll(51, "Line", "F U R U' R' U R U' R' F'"),
  oll(52, "Line", "R U R' U R U' B U' B' R'"),
  oll(53, "L shape", "l' U2 L U L' U' L U L' U l"),
  oll(54, "L shape", "r U2 R' U' R U R' U' R U' r'"),
  oll(55, "Line", "R' F R U R U' R2 F' R2 U' R' U R U R'"),
  oll(56, "Line", "r' U' r U' R' U R U' R' U R r' U r"),
  oll(57, "Corners oriented", "R U R' U' M' U R U' r'"),
];

export const PLL: AlgCase[] = [
  pll("Aa", "Adjacent swap", "x R' U R' D2 R U' R' D2 R2 x'"),
  pll("Ab", "Adjacent swap", "x R2 D2 R U R' D2 R U' R x'"),
  pll("E", "Diagonal swap", "x' R U' R' D R U R' D' R U R' D R U' R' D' x"),
  pll("F", "Adjacent swap", "R' U' F' R U R' U' R' F R2 U' R' U' R U R' U R"),
  pll("Ga", "Adjacent swap", "R2 U R' U R' U' R U' R2 U' D R' U R D'"),
  pll("Gb", "Adjacent swap", "R' U' R U D' R2 U R' U R U' R U' R2 D"),
  pll("Gc", "Adjacent swap", "R2 U' R U' R U R' U R2 U D' R U' R' D"),
  pll("Gd", "Adjacent swap", "R U R' U' D R2 U' R U' R' U R' U R2 D'"),
  pll("H", "Edges only", "M2 U M2 U2 M2 U M2"),
  pll("Ja", "Adjacent swap", "R' U L' U2 R U' R' U2 R L"),
  pll("Jb", "Adjacent swap", "R U R' F' R U R' U' R' F R2 U' R'"),
  pll("Na", "Diagonal swap", "R U R' U R U R' F' R U R' U' R' F R2 U' R' U2 R U' R'"),
  pll("Nb", "Diagonal swap", "R' U R U' R' F' U' F R U R' F R' F' R U' R"),
  pll("Ra", "Adjacent swap", "R U' R' U' R U R D R' U' R D' R' U2 R'"),
  pll("Rb", "Adjacent swap", "R2 F R U R U' R' F' R U2 R' U2 R"),
  pll("T", "Adjacent swap", "R U R' U' R' F R2 U' R' U' R U R' F'"),
  pll("Ua", "Edges only", "M2 U M U2 M' U M2"),
  pll("Ub", "Edges only", "M2 U' M U2 M' U' M2"),
  pll("V", "Diagonal swap", "R' U R' U' y R' F' R2 U' R' U R' F R F"),
  pll("Y", "Diagonal swap", "F R U' R' U' R U R' F' R U R' U' R' F R F'"),
  pll("Z", "Edges only", "M' U M2 U M2 U M' U2 M2"),
];

export const BUILTIN_SETS: Record<string, AlgCase[]> = { OLL, PLL };
