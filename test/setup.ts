// Shared test setup. Runs in every environment (node for the worker tests,
// happy-dom for the src/DOM tests). fake-indexeddb provides a spec-complete
// IndexedDB global so src/idb.ts works under both environments — happy-dom's
// own IDB is incomplete, and node has none.
import "fake-indexeddb/auto";
