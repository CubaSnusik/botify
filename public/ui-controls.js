const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches
let activeSelect = null
let nextId = 0

// Keep the native select as the source of form values and change events. The
// custom control only supplies the themed presentation and keyboard interaction.
class BotifySelect extends HTMLElement {
  connectedCallback () {
    if (!this.select) {
      this.select = this.querySelector('select')
      this.select.hidden = true
      this.select.tabIndex = -1
      this.button = document.createElement('button')
      this.button.type = 'button'
      this.button.className = 'select-trigger input'
      this.button.setAttribute('role', 'combobox')
      this.button.setAttribute('aria-haspopup', 'listbox')
      this.button.setAttribute('aria-expanded', 'false')
      this.caption = document.createElement('span')
      this.caption.className = 'select-caption'
      const arrow = document.createElement('span')
      arrow.className = 'select-arrow'
      arrow.setAttribute('aria-hidden', 'true')
      this.button.append(this.caption, arrow)
      this.append(this.button)
      this.style.width = this.select.style.width || '100%'
      this.button.addEventListener('click', () => this.panel ? this.close() : this.open())
      this.button.addEventListener('keydown', event => this.keydown(event))
      this.select.addEventListener('change', () => this.sync())
      this.select.addEventListener('focus', () => this.button.focus({ preventScroll: true }))
      // App code can assign a value without dispatching change (draft restoration).
      for (const key of ['value', 'selectedIndex']) {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, key)
        Object.defineProperty(this.select, key, {
          configurable: true,
          get: () => descriptor.get.call(this.select),
          set: value => { descriptor.set.call(this.select, value); this.sync() }
        })
      }
      this.observer = new MutationObserver(() => { this.close(); this.sync() })
    }
    this.observer.observe(this.select, { childList: true, subtree: true, characterData: true, attributes: true })
    this.sync()
  }

  disconnectedCallback () {
    this.observer?.disconnect()
    this.close(false)
  }

  sync () {
    const selected = this.select.selectedOptions[0]
    this.caption.textContent = selected?.textContent || '—'
    this.button.disabled = this.select.disabled || !this.select.options.length
    const label = this.select.labels?.[0] || this.closest('.field, .toggle-row')
    const labelText = label?.querySelector(':scope > span, :scope > .t')?.textContent
    this.button.setAttribute('aria-label', this.select.getAttribute('aria-label') || labelText || this.select.title || this.caption.textContent)
    this.button.title = this.select.title
  }

  open () {
    if (this.button.disabled || this.panel) return
    activeSelect?.close()
    activeSelect = this
    this.sync()
    this.activeIndex = Math.max(0, this.select.selectedIndex)
    this.panel = document.createElement('div')
    const panel = this.panel
    panel.className = 'select-popup'
    panel.id = `select-list-${++nextId}`
    panel.setAttribute('role', 'listbox')
    panel.setAttribute('aria-label', this.button.getAttribute('aria-label'))
    this.list = document.createElement('div')
    this.list.className = 'select-options'
    this.items = [...this.select.options].map((option, index) => {
      const item = document.createElement('div')
      item.className = 'select-option'
      item.id = `${panel.id}-${index}`
      item.setAttribute('role', 'option')
      item.setAttribute('aria-selected', String(option.selected))
      item.setAttribute('aria-disabled', String(option.disabled))
      item.textContent = option.textContent
      item.addEventListener('pointermove', () => { if (!option.disabled) this.highlight(index, false) })
      item.addEventListener('pointerdown', event => event.preventDefault())
      item.addEventListener('click', () => this.choose(index))
      this.list.append(item)
      return item
    })
    panel.append(this.list)
    document.body.append(panel)
    const rect = this.button.getBoundingClientRect()
    const below = innerHeight - rect.bottom - 14
    const above = rect.top - 14
    const flip = below < 120 && above > below
    panel.style.width = `${Math.min(Math.max(rect.width, 150), innerWidth - 16)}px`
    const height = Math.min(this.list.scrollHeight + 10, 280, Math.max(40, flip ? above : below))
    panel.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - parseFloat(panel.style.width) - 8))}px`
    panel.style.height = `${height}px`
    if (flip) panel.style.bottom = `${innerHeight - rect.top + 6}px`
    else panel.style.top = `${rect.bottom + 6}px`
    this.button.setAttribute('aria-controls', panel.id)
    this.button.setAttribute('aria-expanded', 'true')
    this.highlight(this.activeIndex)
    if (!reducedMotion()) {
      panel.animate([{ height: '0px', opacity: 0 }, { height: `${height}px`, opacity: 1 }], { duration: 220, easing: 'cubic-bezier(.2,.7,.2,1)' })
      this.list.animate([{ opacity: 0, transform: 'translateY(-5px)' }, { opacity: 1, transform: 'none' }], { duration: 150, delay: 130, fill: 'backwards', easing: 'ease-out' })
    }
    this.outside = event => { if (!this.contains(event.target) && !panel.contains(event.target)) this.close() }
    this.escape = event => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      this.close()
      this.button.focus({ preventScroll: true })
    }
    // Only scrolling an ancestor moves the anchor. A closing dropdown can still
    // emit its own queued scroll event after another dropdown has opened.
    this.scroll = event => {
      if (event.target === document || (event.target instanceof Element && event.target.contains(this))) this.close()
    }
    this.resize = () => this.close()
    document.addEventListener('pointerdown', this.outside, true)
    document.addEventListener('keydown', this.escape, true)
    document.addEventListener('scroll', this.scroll, true)
    window.addEventListener('resize', this.resize)
  }

  highlight (index, scroll = true) {
    this.activeIndex = index
    this.items.forEach((item, i) => item.classList.toggle('active', i === index))
    const item = this.items[index]
    if (item) {
      this.button.setAttribute('aria-activedescendant', item.id)
      if (scroll) {
        const top = item.offsetTop
        const bottom = top + item.offsetHeight
        if (top < this.list.scrollTop) this.list.scrollTop = top
        else if (bottom > this.list.scrollTop + this.list.clientHeight) this.list.scrollTop = bottom - this.list.clientHeight
      }
    }
  }

  choose (index) {
    const option = this.select.options[index]
    if (!option || option.disabled) return
    const changed = this.select.selectedIndex !== index
    this.select.selectedIndex = index
    this.close()
    this.button.focus({ preventScroll: true })
    if (changed) {
      this.select.dispatchEvent(new Event('input', { bubbles: true }))
      this.select.dispatchEvent(new Event('change', { bubbles: true }))
    }
  }

  keydown (event) {
    const key = event.key
    if (key === 'Tab') { this.close(); return }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(key)) {
      event.preventDefault()
      event.stopPropagation()
      if (!this.panel) { this.open(); return }
      if (key === 'Enter' || key === ' ') { this.choose(this.activeIndex); return }
      const enabled = [...this.select.options].map((o, i) => o.disabled ? -1 : i).filter(i => i >= 0)
      const current = enabled.indexOf(this.activeIndex)
      const index = key === 'Home' ? 0 : key === 'End' ? enabled.length - 1 : Math.max(0, Math.min(enabled.length - 1, current + (key === 'ArrowDown' ? 1 : -1)))
      if (enabled[index] != null) this.highlight(enabled[index])
    } else if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault()
      event.stopPropagation()
      this.search = Date.now() - (this.searchAt || 0) > 700 ? key : (this.search || '') + key
      this.searchAt = Date.now()
      this.open()
      const index = [...this.select.options].findIndex(o => !o.disabled && o.textContent.toLocaleLowerCase().startsWith(this.search.toLocaleLowerCase()))
      if (index >= 0) this.highlight(index)
    }
  }

  close (animate = true) {
    if (!this.panel) return
    const panel = this.panel
    this.panel = null
    if (activeSelect === this) activeSelect = null
    this.button.setAttribute('aria-expanded', 'false')
    this.button.removeAttribute('aria-activedescendant')
    this.button.removeAttribute('aria-controls')
    document.removeEventListener('pointerdown', this.outside, true)
    document.removeEventListener('keydown', this.escape, true)
    document.removeEventListener('scroll', this.scroll, true)
    window.removeEventListener('resize', this.resize)
    panel.style.pointerEvents = 'none'
    if (animate && !reducedMotion()) {
      for (const animation of panel.getAnimations({ subtree: true })) animation.cancel()
      panel.firstChild.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 90, fill: 'forwards' })
      panel.animate([{ height: panel.style.height, opacity: 1 }, { height: '0px', opacity: 0 }], { duration: 170, delay: 50, fill: 'forwards', easing: 'ease-in-out' }).finished.then(() => panel.remove(), () => panel.remove())
    } else panel.remove()
  }
}

class BotifySegment extends HTMLElement {
  connectedCallback () {
    this.observer = new MutationObserver(() => this.update())
    this.observer.observe(this, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })
    this.resizeObserver = new ResizeObserver(() => this.update())
    this.resizeObserver.observe(this)
    this.update()
  }

  disconnectedCallback () {
    this.observer?.disconnect()
    this.resizeObserver?.disconnect()
    cancelAnimationFrame(this.frame)
  }

  update () {
    cancelAnimationFrame(this.frame)
    this.frame = requestAnimationFrame(() => {
      const active = this.querySelector('button.on')
      if (!active || !this.isConnected) return
      this.querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', String(button === active)))
      this.style.setProperty('--seg-x', `${active.offsetLeft}px`)
      this.style.setProperty('--seg-y', `${active.offsetTop}px`)
      this.style.setProperty('--seg-w', `${active.offsetWidth}px`)
      this.style.setProperty('--seg-h', `${active.offsetHeight}px`)
      if (!this.hasAttribute('data-ready')) requestAnimationFrame(() => { if (this.isConnected) this.setAttribute('data-ready', '') })
    })
  }
}

customElements.define('botify-select', BotifySelect)
customElements.define('botify-segment', BotifySegment)

export function wrapSelect (select) {
  const wrapper = document.createElement('botify-select')
  wrapper.append(select)
  return wrapper
}
