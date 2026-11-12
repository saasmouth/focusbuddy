// The script that runs inside every desk web page, in the PAGE's own world,
// before the page's scripts (injected by src/preload/drmProbe.ts with
// contextBridge.executeInMainWorld). It does two jobs:
//
// 1. WAIT, so a page never fails just because it was early. On a first launch
//    the Widevine CDM is still downloading when the first page asks for it.
//    `navigator.requestMediaKeySystemAccess('com.widevine.alpha', …)` is held
//    until main says the CDM has settled (ready, failed, or a time limit),
//    then handed to the real function. Other key systems pass straight
//    through, and nothing else in the page is delayed.
//
// 2. NOTICE when protected video is refused, and say so to main:
//      - requestMediaKeySystemAccess for Widevine rejected;
//      - a Widevine licence that never arrives, is refused when applied, or
//        leaves every key unusable;
//      - Netflix's error screen showing a DRM error code (Netflix pages only).
//    Main decides what, if anything, to tell the person (src/shared/drm.ts).
//
// CONSTRAINTS, because of how it is delivered:
//  - Electron SERIALIZES this function into the page. It may use nothing from
//    outside its own body: no imports, no module-level helpers. Everything it
//    needs comes in as arguments. (tests/unit/drmMainWorldProbe.test.ts runs
//    it from its source text, which is how a closure would be caught.)
//  - It runs among the page's own scripts. The wrapped functions are Proxies
//    of the originals, so they still read as native code to a page that
//    inspects them, and every call reaches the real function.
//  - It must never break or block a page: every hook is wrapped in try/catch,
//    reports are fire-and-forget, and the real result (or error) is always
//    what the page gets.

export interface DrmProbeConfig {
  /** Watch the page text for Netflix's DRM error codes (Netflix hosts only). */
  watchNetflix: boolean
  /** RegExp source for a Netflix error code; group 1 is the family (e.g. 7701). */
  netflixCodeSource: string
  /** Families that mean DRM (src/shared/drm.ts netflixDrmCode). */
  netflixFamilies: string[]
  /** How long a licence request may go unanswered before it counts as failed. */
  licenceWaitMs: number
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function drmMainWorldProbe(
  waitForCdm: () => unknown,
  report: (evidence: Record<string, unknown>) => void,
  cfg: DrmProbeConfig,
  scope?: any
): string {
  const g: any = scope || globalThis
  const installed: string[] = []
  const KS = 'com.widevine.alpha'
  const isWv = (ks: unknown): boolean => typeof ks === 'string' && (ks === KS || ks.indexOf(KS + '.') === 0)
  const P: PromiseConstructor = g.Promise
  const send = (e: Record<string, unknown>): void => {
    try {
      report(e)
    } catch {
      /* the bridge is gone (page unloading) */
    }
  }
  const errText = (err: any): string | undefined => {
    try {
      return err && err.message ? String(err.message).slice(0, 200) : undefined
    } catch {
      return undefined
    }
  }
  // Replace a method with a Proxy of itself, keeping the property's shape.
  const hook = (owner: any, name: string, handler: ProxyHandler<any>): boolean => {
    try {
      const d = owner && Object.getOwnPropertyDescriptor(owner, name)
      if (!d || typeof d.value !== 'function') return false
      Object.defineProperty(owner, name, {
        value: new Proxy(d.value, handler),
        writable: d.writable,
        enumerable: d.enumerable,
        configurable: d.configurable
      })
      return true
    } catch {
      return false
    }
  }

  // ── 1. requestMediaKeySystemAccess: wait for the CDM, notice a refusal ─────
  const navProto = g.Navigator && g.Navigator.prototype
  if (
    hook(navProto, 'requestMediaKeySystemAccess', {
      apply(target: any, self: any, args: any[]) {
        const keySystem = args[0]
        if (!isWv(keySystem)) return Reflect.apply(target, self, args)
        return new P((resolve: (v: unknown) => void) => {
          let waited: any
          try {
            waited = waitForCdm()
          } catch {
            waited = undefined
          }
          P.resolve(waited).then(
            () => resolve(undefined),
            () => resolve(undefined)
          )
        })
          .then(() => Reflect.apply(target, self, args))
          .then(
            (access: unknown) => access,
            (err: any) => {
              send({ kind: 'mksa-rejected', keySystem, name: err && err.name, message: errText(err) })
              throw err
            }
          )
      }
    })
  )
    installed.push('mksa')

  // ── 2. Licences: only for MediaKeys made from a Widevine access ──────────
  const widevineKeys = new WeakSet<object>()
  const accessProto = g.MediaKeySystemAccess && g.MediaKeySystemAccess.prototype
  if (
    hook(accessProto, 'createMediaKeys', {
      apply(target: any, self: any, args: any[]) {
        const p: any = Reflect.apply(target, self, args)
        try {
          if (isWv(self && self.keySystem) && p && typeof p.then === 'function') {
            p.then(
              (mk: object) => {
                try {
                  widevineKeys.add(mk)
                } catch {
                  /* not an object */
                }
              },
              () => undefined
            )
          }
        } catch {
          /* keySystem unreadable */
        }
        return p
      }
    })
  )
    installed.push('keys')

  const watchSession = (s: any): void => {
    let timer: any = null
    let failed = false
    const fail = (e: Record<string, unknown>): void => {
      if (failed) return
      failed = true
      send(e)
    }
    const clear = (): void => {
      if (timer !== null) {
        g.clearTimeout(timer)
        timer = null
      }
    }
    s.addEventListener('message', (ev: any) => {
      const t = ev && ev.messageType
      if (t !== 'license-request' && t !== 'license-renewal') return
      clear()
      timer = g.setTimeout(() => {
        timer = null
        fail({ kind: 'licence-failed', how: 'no-licence' })
      }, cfg.licenceWaitMs)
    })
    s.addEventListener('keystatuseschange', () => {
      const statuses: string[] = []
      try {
        s.keyStatuses.forEach((st: string) => statuses.push(st))
      } catch {
        return
      }
      // A refusal only when NO key can play: a site may hold HD keys back and
      // still play SD, which is not a failure.
      if (statuses.length === 0) return
      if (statuses.some((st) => st === 'usable' || st === 'status-pending' || st === 'output-downscaled' || st === 'usable-in-future')) return
      const bad = statuses.find((st) => st === 'internal-error' || st === 'output-restricted')
      if (bad) fail({ kind: 'licence-failed', how: 'key-status', status: bad })
    })
    hook(s, 'update', {
      apply(target: any, self: any, args: any[]) {
        clear()
        const p: any = Reflect.apply(target, self, args)
        if (p && typeof p.then === 'function') {
          p.then(undefined, (err: any) => fail({ kind: 'licence-failed', how: 'update-rejected', message: errText(err) }))
        }
        return p
      }
    })
    try {
      if (s.closed && typeof s.closed.then === 'function') s.closed.then(clear, clear)
    } catch {
      /* no closed promise */
    }
  }

  const keysProto = g.MediaKeys && g.MediaKeys.prototype
  if (
    hook(keysProto, 'createSession', {
      apply(target: any, self: any, args: any[]) {
        const s = Reflect.apply(target, self, args)
        try {
          // `update` is an inherited method; give this session its own hooked copy.
          if (widevineKeys.has(self) && s) {
            const proto = Object.getPrototypeOf(s)
            const d = proto && Object.getOwnPropertyDescriptor(proto, 'update')
            if (d && typeof d.value === 'function') {
              Object.defineProperty(s, 'update', { value: d.value, writable: true, enumerable: false, configurable: true })
            }
            watchSession(s)
          }
        } catch {
          /* never break session creation */
        }
        return s
      }
    })
  )
    installed.push('sessions')

  // ── 3. Netflix's own error screen ─────────────────────────────────────────
  if (cfg.watchNetflix && g.MutationObserver && g.document) {
    const seen: Record<string, boolean> = {}
    let pending: any = null
    const scan = (): void => {
      pending = null
      const body = g.document.body
      if (!body) return
      let text = ''
      try {
        text = String(body.innerText || '')
      } catch {
        return
      }
      const re = new RegExp(cfg.netflixCodeSource, 'g')
      let m: RegExpExecArray | null
      while ((m = re.exec(text))) {
        if (cfg.netflixFamilies.indexOf(m[1]) === -1 || seen[m[0]]) continue
        seen[m[0]] = true
        send({ kind: 'site-error', site: 'netflix', code: m[0] })
      }
    }
    const schedule = (): void => {
      if (pending === null) pending = g.setTimeout(scan, 800)
    }
    try {
      new g.MutationObserver(schedule).observe(g.document, { subtree: true, childList: true, characterData: true })
      schedule()
      installed.push('netflix')
    } catch {
      /* no observer */
    }
  }

  return installed.join(',')
}
/* eslint-enable @typescript-eslint/no-explicit-any */
