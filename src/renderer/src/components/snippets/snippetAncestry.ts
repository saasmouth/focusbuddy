import { createContext } from 'react'

// The chain of snippet ids currently being rendered, outermost first.
//
// A snippet can hold a document fragment, and a document fragment can hold a
// live snippet, so a snippet can contain another snippet. That is a feature.
// What it also allows is a CYCLE: snippet A containing a live instance of A, or
// A containing B containing A. Resolving one would mount an embed inside itself
// forever and take the window with it.
//
// It only became reachable with edit-in-place. Before that a snippet's body came
// from a document selection, and saving always produced a NEW snippet, so no
// body could refer to itself. Editing a master from inside a placed instance
// means a user can now insert B into A's body while B already contains A.
//
// The read-only render path is not at risk — it goes through docToHtml, which
// serialises a nested embed to a static div rather than mounting a node view —
// but the inline editor uses the real schema with real node views, which is
// exactly where this would bite.
//
// So each embed adds its own id for its children, and refuses to resolve an id
// already in the chain, naming the problem instead of recursing.
export const SnippetAncestry = createContext<readonly string[]>([])
