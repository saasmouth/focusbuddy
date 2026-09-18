// The things people actually want a browser agent to do, as one click.
//
// The ask box is a blank field and a blinking cursor, which is the worst way to
// meet a capability you have never used: it asks you to guess both what the
// agent can do and how to phrase it. Most sessions want one of a handful of
// things — what does this page say, what does it link to, what are the options,
// get me this data — so those are offered by name.
//
// Each preset is a fully-formed TASK, not a keyword. The agent's loop reads
// plain instructions, so "Summarise" alone would produce a run that reads one
// screenful and stops; the wording here is what makes the run finish properly
// and record what it found. Free text stays: the presets are a floor, not a
// menu you are confined to.

export interface QuickTask {
  /** Stable id — used in tests and as the React key. */
  id: string
  /** What the button says. */
  label: string
  /** Material icon name. */
  icon: string
  /** The task handed to the agent. */
  task: string
}

// Every preset ends by saying what to record, because a run that reads well and
// records nothing delivers nothing: the findings are the whole yield.
export const QUICK_TASKS: readonly QuickTask[] = [
  {
    id: 'summarise',
    label: 'Summarise',
    icon: 'summarize',
    task:
      'Read this page in full — scroll until you have seen it all rather than stopping at the first screenful — and write a clear summary of what it says. ' +
      'Record the summary as the answer, and record any concrete facts, figures or dates as records.'
  },
  {
    id: 'links',
    label: 'Links',
    icon: 'link',
    task:
      'Collect the links on this page. Use the collect action with what="links", then record the ones that actually matter — skip navigation, login, social and footer boilerplate. ' +
      'Record each as a record with fields: title, url. If the page is a list of results, follow nothing — just gather what is here.'
  },
  {
    id: 'images',
    label: 'Images',
    icon: 'image',
    task:
      'Collect the images on this page. Use the collect action with what="images", then record the content images — skip logos, icons, avatars and decoration. ' +
      'Record each as a record with fields: description, url, size. Use the alt text for the description where there is one, and say so plainly when there is none rather than inventing one.'
  },
  {
    id: 'extract',
    label: 'Extract data',
    icon: 'table',
    task:
      'Extract the structured data on this page into records — the listings, rows, products, people or results it shows. ' +
      'Work out the right columns from what the page actually contains and use the same fields for every record. ' +
      'Scroll to the bottom so you capture every row, not just the first screenful. Do not invent values: leave a field out when the page does not say.'
  },
  {
    id: 'similar',
    label: 'Find similar',
    icon: 'travel_explore',
    task:
      'Work out what this page is about, then find comparable alternatives to it elsewhere on the web. ' +
      'Search, open the promising results, and record each option with fields: name, what makes it different, url, and price if there is one. ' +
      'Aim for at least five genuinely different options, and say in the answer how they compare.'
  },
  {
    id: 'research',
    label: 'Research',
    icon: 'search',
    task:
      'Research the subject of this page properly: follow the leads that matter, read several sources rather than one, and cross-check anything that looks like a claim. ' +
      'Record what you learn as you go, with a url for every fact so it can be checked. Note in the answer where sources disagree, rather than picking one and moving on.'
  }
]

export function quickTaskById(id: string): QuickTask | null {
  return QUICK_TASKS.find((q) => q.id === id) ?? null
}
