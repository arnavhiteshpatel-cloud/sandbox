// Thin entry: everything (including code shared with cubing.js web workers) lives in
// separately-loaded chunks, so workers never execute the UI bootstrap.
import("./boot");
