// Nothing in the browser graph should reach better-sqlite3: the database module
// that imports it is swapped out before this can be pulled in. It is aliased to
// this rather than left to fail during bundling so that, if some path does
// reach it, the message says which module is at fault instead of surfacing as a
// missing Node builtin three layers down.
export default class NotAvailable {
  constructor() {
    throw new Error(
      'better-sqlite3 was reached in the browser runtime. Something imports ' +
        'src/main/db/database.ts by a path the module swap does not cover.'
    )
  }
}
