/**
 * Functions whose source is serialized and evaluated inside the isolated page.
 * They must stay self-contained: no imports and no references to module scope.
 */

/** Structured page observation returned to the model. */
export interface PageSnapshot {
  url: string
  title: string
  text: string
  textTruncated: boolean
  controls: Array<{
    ref: string
    role: string
    name: string
    value?: string
    href?: string
    disabled?: boolean
    checked?: boolean
    options?: string[]
  }>
  controlsTruncated: boolean
  dialogs: string[]
  alerts: string[]
  viewport: { width: number; height: number; scrollY: number; scrollHeight: number }
  focused?: { ref?: string; tag: string; name: string }
}

/**
 * Walk the visible DOM, tag interactive elements with stable `data-dsh-ref`
 * attributes, and return readable text plus a control list.
 * @param maxText - maximum characters of page text.
 * @param maxRefs - maximum interactive controls to tag.
 * @returns the page snapshot.
 */
export function snapshotInPage(maxText: number, maxRefs: number): PageSnapshot {
  if (document.body === null) {
    return {
      url: location.href,
      title: document.title,
      text: '',
      textTruncated: false,
      controls: [],
      controlsTruncated: false,
      dialogs: [],
      alerts: [],
      viewport: { width: window.innerWidth, height: window.innerHeight, scrollY: 0, scrollHeight: 0 },
    }
  }
  const state = { refs: [] as PageSnapshot['controls'], count: 0, truncated: false }
  document.querySelectorAll('[data-dsh-ref]').forEach(element => element.removeAttribute('data-dsh-ref'))

  const visibilityCache = new WeakMap<Element, boolean>()
  const isVisible = (element: Element): boolean => {
    const cached = visibilityCache.get(element)
    if (cached !== undefined) return cached
    const style = window.getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    const visible = style.display !== 'none'
      && style.visibility !== 'hidden'
      && style.opacity !== '0'
      && rect.width > 0
      && rect.height > 0
    visibilityCache.set(element, visible)
    return visible
  }

  const labelFor = (element: Element): string => {
    const id = element.getAttribute('id')
    if (id !== null) {
      const explicit = document.querySelector(`label[for="${id.replace(/["\\]/g, '\\$&')}"]`)
      if (explicit !== null) return (explicit.textContent ?? '').trim()
    }
    const wrapping = element.closest('label')
    if (wrapping !== null) return (wrapping.textContent ?? '').trim()
    return ''
  }

  const roleOf = (element: Element): string => {
    const explicit = element.getAttribute('role')
    if (explicit !== null && explicit.length > 0) return explicit
    const tag = element.tagName.toLowerCase()
    if (tag === 'a') return 'link'
    if (tag === 'button' || tag === 'summary') return 'button'
    if (tag === 'select') return 'combobox'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'input') {
      const type = (element as HTMLInputElement).type
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return 'button'
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      if (type === 'file') return 'file'
      if (type === 'search') return 'searchbox'
      if (type === 'range') return 'slider'
      return 'textbox'
    }
    if (element.getAttribute('contenteditable') === 'true') return 'textbox'
    return tag
  }

  const nameOf = (element: Element): string => {
    const aria = element.getAttribute('aria-label')
    if (aria !== null && aria.trim().length > 0) return aria.trim()
    const labelledBy = element.getAttribute('aria-labelledby')
    if (labelledBy !== null) {
      const parts = labelledBy.split(/\s+/)
        .map(id => document.getElementById(id)?.textContent ?? '')
        .join(' ')
        .trim()
      if (parts.length > 0) return parts
    }
    const placeholder = element.getAttribute('placeholder')
    if (placeholder !== null && placeholder.trim().length > 0) return placeholder.trim()
    const label = labelFor(element)
    if (label.length > 0) return label
    if (element instanceof HTMLInputElement) {
      if (element.type === 'submit' || element.type === 'button' || element.type === 'reset') return element.value
      const name = element.getAttribute('name')
      if (name !== null && name.length > 0) return name
    }
    const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (text.length > 0) return text.slice(0, 160)
    const attrName = element.getAttribute('name')
    if (attrName !== null && attrName.length > 0) return attrName
    const title = element.getAttribute('title')
    if (title !== null && title.length > 0) return title
    const alt = element.getAttribute('alt')
    if (alt !== null && alt.length > 0) return alt
    return ''
  }

  const controlValue = (element: Element): string | undefined => {
    if (element instanceof HTMLInputElement) {
      if (element.type === 'password') return element.value.length === 0 ? undefined : '••••'
      if (element.type === 'checkbox' || element.type === 'radio') return undefined
      return element.value.length > 0 ? element.value.slice(0, 300) : undefined
    }
    if (element instanceof HTMLTextAreaElement) return element.value.length > 0 ? element.value.slice(0, 300) : undefined
    if (element instanceof HTMLSelectElement) return element.value
    if (element.getAttribute('contenteditable') === 'true') {
      const text = (element.textContent ?? '').trim()
      return text.length > 0 ? text.slice(0, 300) : undefined
    }
    return undefined
  }

  const selector = [
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'textarea',
    'select',
    'summary',
    '[role="button"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="combobox"]',
    '[role="textbox"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[contenteditable="true"]',
    '[onclick]',
  ].join(',')

  for (const element of Array.from(document.querySelectorAll(selector))) {
    if (state.count >= maxRefs) {
      state.truncated = true
      break
    }
    if (!isVisible(element)) continue
    if (element instanceof HTMLInputElement && (element.type === 'hidden' || element.disabled && element.type === 'file')) continue
    const ref = `e${state.count + 1}`
    element.setAttribute('data-dsh-ref', ref)
    state.count += 1
    const value = controlValue(element)
    const entry: PageSnapshot['controls'][number] = {
      ref,
      role: roleOf(element),
      name: nameOf(element).replace(/\s+/g, ' ').trim(),
      ...value === undefined ? {} : { value },
    }
    if (element instanceof HTMLAnchorElement) {
      const href = element.getAttribute('href')
      if (href !== null && href.length > 0) entry.href = href.slice(0, 500)
    }
    if ('disabled' in element && (element as HTMLButtonElement).disabled) entry.disabled = true
    if (element instanceof HTMLInputElement && (element.type === 'checkbox' || element.type === 'radio')) {
      entry.checked = element.checked
    }
    if (element instanceof HTMLSelectElement) {
      entry.options = Array.from(element.options).slice(0, 40).map(option => option.value === '' ? option.text : option.value)
    }
    state.refs.push(entry)
  }

  const chunks: string[] = []
  let length = 0
  let textTruncated = false
  const blockTags = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DIV', 'DL', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TR', 'UL'])
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  let visited = 0
  while (node !== null && visited < 20_000) {
    visited += 1
    const textNode = node
    const parent = textNode.parentElement
    node = walker.nextNode()
    if (parent === null) continue
    const tag = parent.tagName.toUpperCase()
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE' || tag === 'SVG') continue
    if (!isVisible(parent)) continue
    const raw = (textNode.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (raw.length === 0) continue
    const piece = blockTags.has(tag) ? `${raw}\n` : `${raw} `
    if (length + piece.length > maxText) {
      chunks.push(piece.slice(0, Math.max(0, maxText - length)))
      textTruncated = true
      break
    }
    chunks.push(piece)
    length += piece.length
  }

  const dialogTexts = Array.from(document.querySelectorAll('[role="dialog"],[aria-modal="true"]'))
    .filter(dialog => isVisible(dialog))
    .slice(0, 5)
    .map(dialog => (dialog.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 800))
  const alerts = Array.from(document.querySelectorAll('[role="alert"],[aria-live="assertive"]'))
    .filter(alert => isVisible(alert))
    .slice(0, 10)
    .map(alert => (alert.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 500))
    .filter(text => text.length > 0)

  const active = document.activeElement
  const focusedRef = active === null ? undefined : active.getAttribute('data-dsh-ref') ?? undefined
  return {
    url: location.href,
    title: document.title,
    text: chunks.join('').replace(/[ \t]+\n/g, '\n').trim(),
    textTruncated,
    controls: state.refs,
    controlsTruncated: state.truncated,
    dialogs: dialogTexts,
    alerts,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      scrollY: Math.round(window.scrollY),
      scrollHeight: Math.max(document.body?.scrollHeight ?? 0, document.documentElement?.scrollHeight ?? 0),
    },
    ...active === null ? {} : {
      focused: {
        ...focusedRef === undefined ? {} : { ref: focusedRef },
        tag: active.tagName.toLowerCase(),
        name: nameOf(active).replace(/\s+/g, ' ').trim().slice(0, 160),
      },
    },
  }
}

/**
 * Perform one DOM action on a tagged control.
 * @param action - click, type, select, or scroll.
 * @param ref - control ref from the latest snapshot.
 * @param text - text to type or select value; for scroll, `down`/`up`/`top`/`bottom`.
 * @param submit - request form submission after typing.
 * @returns action outcome, including the current URL.
 */
export function actInPage(action: string, ref: string, text: string, submit: boolean): Record<string, unknown> {
  if (action === 'scroll') {
    const height = window.innerHeight
    if (text === 'up') window.scrollBy({ top: -height * 0.8, behavior: 'instant' })
    else if (text === 'top') window.scrollTo({ top: 0, behavior: 'instant' })
    else if (text === 'bottom') window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' })
    else window.scrollBy({ top: height * 0.8, behavior: 'instant' })
    return { ok: true, url: location.href, scrollY: Math.round(window.scrollY) }
  }
  const element = document.querySelector(`[data-dsh-ref="${ref}"]`)
  if (!(element instanceof HTMLElement)) {
    return { ok: false, error: `unknown ref ${JSON.stringify(ref)}; take a new snapshot` }
  }
  element.scrollIntoView({ block: 'center', inline: 'center' })
  if (element.getAttribute('aria-disabled') === 'true' || ('disabled' in element && (element as HTMLButtonElement).disabled)) {
    return { ok: false, error: `control ${ref} is disabled` }
  }
  if (action === 'click') {
    if (element instanceof HTMLInputElement && element.type === 'file') {
      return { ok: false, error: 'file inputs need a file chooser; this build does not expose upload' }
    }
    if (element instanceof HTMLAnchorElement && element.target === '_blank') element.target = '_self'
    element.click()
    return { ok: true, url: location.href, tag: element.tagName.toLowerCase() }
  }
  if (action === 'type') {
    element.focus()
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      const prototype = element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
      if (setter === undefined) return { ok: false, error: 'could not set this input value' }
      setter.call(element, text)
      element.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
      element.dispatchEvent(new Event('change', { bubbles: true }))
    } else if (element.getAttribute('contenteditable') === 'true') {
      element.textContent = text
      element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: text, inputType: 'insertText' }))
    } else {
      return { ok: false, error: `control ${ref} is a ${element.tagName.toLowerCase()}, not a text field` }
    }
    if (submit) {
      const form = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
        ? element.form
        : element.closest('form')
      if (form === null || form === undefined) return { ok: true, url: location.href, submitted: false, note: 'no owning form' }
      if (typeof form.requestSubmit === 'function') form.requestSubmit()
      else form.submit()
      return { ok: true, url: location.href, submitted: true }
    }
    return { ok: true, url: location.href, value: element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : text }
  }
  if (action === 'select') {
    if (!(element instanceof HTMLSelectElement)) {
      return { ok: false, error: `control ${ref} is not a select` }
    }
    const option = Array.from(element.options).find(candidate => candidate.value === text || candidate.text === text)
    if (option === undefined) {
      return { ok: false, error: `no option equals ${JSON.stringify(text)}`, options: Array.from(element.options).map(candidate => candidate.value) }
    }
    element.value = option.value
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
    return { ok: true, url: location.href, value: element.value }
  }
  return { ok: false, error: `unsupported action ${JSON.stringify(action)}` }
}

/**
 * Poll for a selector or visible text. Returns the boolean result so the host
 * keeps its own timeout and cancellation.
 */
export function waitInPage(selector: string, text: string): boolean {
  if (selector.length > 0 && document.querySelector(selector) === null) return false
  if (text.length > 0) {
    const body = document.body?.innerText ?? document.body?.textContent ?? ''
    return body.includes(text)
  }
  return true
}
