import { Book } from './lib/epub.js'
import { Pager } from './lib/pager.js'
import { SearchIndex } from './lib/search.js'

const BOOK_URL = 'book.epub'
const STORAGE_KEY = 'hatoyama-reader:v2'
const FONT_SIZES = [14, 15, 16, 17, 18, 19, 20, 22, 24, 26, 28, 32]
const LINE_HEIGHTS = { tight: 1.75, normal: 1.95, loose: 2.25 }

const $ = selector => document.querySelector(selector)

// ---- persisted state ------------------------------------------------------

const storage = {
    load() {
        try {
            return JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? {}
        } catch {
            return {}
        }
    },
    save(data) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
        } catch { /* storage unavailable (private mode etc.) */ }
    },
}

const saved = storage.load()
const settings = {
    fontSize: matchMedia('(max-width: 640px)').matches ? 17 : 19,
    lineHeight: 'normal',
    font: 'mincho',
    writing: 'vertical',
    ruby: 'on',
    theme: 'auto',
    ...saved.settings,
}
let position = saved.position ?? null // { path, anchor }

let persistTimer
const persist = () => {
    clearTimeout(persistTimer)
    persistTimer = setTimeout(() => storage.save({ settings, position }), 300)
}

// ---- loading ---------------------------------------------------------------

const loader = {
    progress(fraction) {
        $('#loader-progress').style.width = `${Math.round(Math.min(1, fraction) * 100)}%`
    },
    message(text) {
        $('#loader-message').textContent = text
    },
    fail(error) {
        console.error(error)
        this.message(`読み込みに失敗しました。${error?.message ?? ''}`)
        $('#loader-retry').hidden = false
    },
    done() {
        $('#loader').classList.add('done')
    },
}

async function fetchWithProgress(url, onProgress) {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const total = Number(response.headers.get('content-length')) || 0
    if (!response.body || !total) return response.arrayBuffer()
    const reader = response.body.getReader()
    const chunks = []
    let received = 0
    for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        received += value.length
        onProgress(received / total)
    }
    const buffer = new Uint8Array(received)
    let offset = 0
    for (const chunk of chunks) {
        buffer.set(chunk, offset)
        offset += chunk.length
    }
    return buffer.buffer
}

// ---- app -------------------------------------------------------------------

class App {
    book
    pager
    index = null
    weights = []
    chromeVisible = false
    #highlightTimer

    async start() {
        this.applySettings({ relayout: false })
        loader.message('本を読み込んでいます…')
        const buffer = await fetchWithProgress(BOOK_URL, f => loader.progress(f * .85))
        loader.message('書体を準備しています…')
        this.book = await Book.open(buffer)
        this.#injectBookStyles()
        await this.book.loadFonts().catch(e => console.warn('Font loading failed', e))
        loader.progress(1)

        this.weights = this.book.spine.map(s => s.size)
        this.pager = new Pager({
            stage: $('#stage'),
            viewport: $('#viewport'),
            content: $('#content'),
            book: this.book,
        })
        this.pager.vertical = settings.writing === 'vertical'
        this.pager.addEventListener('relocate', e => this.#onRelocate(e.detail))

        this.#renderMetadata()
        this.#bindNavigation()
        this.#bindPanels()
        this.#bindSettings()
        this.#bindSearch()

        await this.#restorePosition()
        loader.done()
        this.#buildIndex()
    }

    // ---- setup ----------------------------------------------------------

    #injectBookStyles() {
        const style = document.createElement('style')
        style.textContent = `@layer book {\n${this.book.css}\n}`
        document.head.prepend(style)
    }

    #renderMetadata() {
        const { metadata, spine, toc } = this.book
        const title = metadata.title || '無題'
        const author = metadata.creators.map(c => c.name.replace(/\s+/g, '')).join('、')
        document.title = author ? `${title} — ${author}` : title
        $('#book-title').textContent = $('#card-title').textContent = title
        $('#book-author').textContent = $('#card-author').textContent = author

        if (this.book.coverPath)
            this.book.resourceURL(this.book.coverPath).then(url => $('#cover-thumb').src = url)

        const list = $('#toc-list')
        const build = (items, parent) => {
            for (const item of items) {
                const li = document.createElement('li')
                const a = document.createElement('a')
                a.href = '#'
                const [, num, rest] = item.label.match(/^([一二三四五六七八九〇十]+)\s+(.+)$/) ?? []
                if (num) {
                    const n = document.createElement('span')
                    n.className = 'toc-num'
                    n.textContent = num
                    a.append(n, rest)
                } else a.textContent = item.label
                a.dataset.path = item.path ?? ''
                a.addEventListener('click', e => {
                    e.preventDefault()
                    this.closePanels()
                    this.goToPath(item.path, item.fragment)
                })
                li.append(a)
                if (item.children.length) {
                    const ol = document.createElement('ol')
                    build(item.children, ol)
                    li.append(ol)
                }
                parent.append(li)
            }
        }
        build(toc, list)

        const credits = $('#credits')
        for (const c of metadata.contributors) {
            const li = document.createElement('li')
            li.textContent = c.name
            credits.append(li)
        }
        credits.closest('details').hidden = !metadata.contributors.length
        // Keep spine titles for sections missing from the TOC.
        spine.forEach((s, i) => s.title ??= i === 0 ? '表紙' : '')
    }

    async #restorePosition() {
        const index = position ? this.book.spineIndexOf(position.path) : -1
        if (index >= 0) await this.pager.display(index, { anchor: position.anchor })
        else {
            await this.pager.display(0)
            const touch = matchMedia('(pointer: coarse)').matches
            this.toast(touch
                ? '左右をタップ・スワイプでページをめくれます'
                : '← → キー・クリック・ホイールでページをめくれます', 5000)
        }
    }

    async #buildIndex() {
        try {
            this.index = await SearchIndex.build(this.book)
            this.weights = this.index.lengths.map((n, i) => Math.max(n, i === 0 ? 1 : 0) || 1)
            this.#updateProgress()
            if (!$('#search-panel').hidden) this.runSearch()
        } catch (e) {
            console.error('Indexing failed', e)
        }
    }

    // ---- navigation -----------------------------------------------------

    async goToPath(path, fragment) {
        const index = this.book.spineIndexOf(path)
        if (index < 0) return
        await this.pager.display(index, fragment ? { fragment } : { page: 0 })
    }

    next() {
        this.#clearHighlight()
        return this.pager.next()
    }

    prev() {
        this.#clearHighlight()
        return this.pager.prev()
    }

    // Physical directions map to reading order depending on the writing mode.
    goLeft() {
        return this.pager.vertical ? this.next() : this.prev()
    }

    goRight() {
        return this.pager.vertical ? this.prev() : this.next()
    }

    #bindNavigation() {
        const stage = $('#stage')

        document.addEventListener('keydown', e => {
            if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return
            const typing = e.target.closest?.('input, textarea, [contenteditable]')
            if (e.key === 'Escape') {
                if (this.closePanels()) return
                return this.setChrome(false)
            }
            if (typing || this.panelOpen) return
            switch (e.key) {
                case 'ArrowLeft': this.goLeft(); break
                case 'ArrowRight': this.goRight(); break
                case 'ArrowDown': case 'PageDown': this.next(); break
                case 'ArrowUp': case 'PageUp': this.prev(); break
                case ' ': e.shiftKey ? this.prev() : this.next(); break
                case 'Home': this.pager.display(this.pager.section, { page: 0 }); break
                case 'End': this.pager.display(this.pager.section, { page: 'last' }); break
                case 't': case 'T': this.openPanel('toc'); break
                case '/': this.openPanel('search'); break
                default: return
            }
            e.preventDefault()
        })

        // Tap zones and swipes.
        let start = null
        stage.addEventListener('pointerdown', e => {
            // A tap that only dismisses the settings popover should not turn the page.
            if (!e.isPrimary || e.button > 0 || this.#closeSettings()) return start = null
            start = { x: e.clientX, y: e.clientY, t: performance.now() }
        })
        stage.addEventListener('pointercancel', () => start = null)
        stage.addEventListener('pointerup', e => {
            if (!start || !e.isPrimary) return
            const dx = e.clientX - start.x
            const dy = e.clientY - start.y
            const dt = performance.now() - start.t
            start = null
            if (e.target.closest('a[href], button')) return
            if (String(getSelection()).trim()) return

            if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5 && dt < 800) {
                // Swipe: dragging the page towards the side it came from turns back.
                return dx > 0 ? this.goRight() : this.goLeft()
            }
            if (Math.hypot(dx, dy) > 10) return

            const rect = stage.getBoundingClientRect()
            const x = (e.clientX - rect.left) / rect.width
            if (x < .3 || x > .7) {
                this.setChrome(false)
                return x < .3 ? this.goLeft() : this.goRight()
            }
            this.setChrome(!this.chromeVisible)
        })

        // Wheel / trackpad: one page per gesture.
        let wheelLock = false, wheelIdle, wheelSum = 0
        stage.addEventListener('wheel', e => {
            e.preventDefault()
            clearTimeout(wheelIdle)
            wheelIdle = setTimeout(() => {
                wheelLock = false
                wheelSum = 0
            }, 180)
            if (wheelLock) return
            wheelSum += Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY
                : this.pager.vertical ? -e.deltaX : e.deltaX
            if (Math.abs(wheelSum) < 30) return
            wheelLock = true
            wheelSum > 0 ? this.next() : this.prev()
        }, { passive: false })

        $('#edge-left').addEventListener('click', () => this.goLeft())
        $('#edge-right').addEventListener('click', () => this.goRight())

        // Links inside the book (e.g. its own table of contents).
        $('#content').addEventListener('click', e => {
            const a = e.target.closest('a[data-path]')
            if (!a) return
            e.preventDefault()
            this.goToPath(a.dataset.path, a.dataset.fragment)
        })

        let resizeTimer
        new ResizeObserver(() => {
            clearTimeout(resizeTimer)
            resizeTimer = setTimeout(() => this.pager.relayout(), 120)
        }).observe(stage)

        // Slider over the whole book.
        const slider = $('#slider')
        const preview = $('#slider-preview')
        slider.addEventListener('input', () => {
            const { section } = this.#fractionToLocation(slider.value / 1000)
            preview.hidden = false
            preview.textContent = this.book.spine[section].title || ''
            const ratio = slider.value / 1000
            const pos = slider.dir === 'rtl' ? 1 - ratio : ratio
            preview.style.left = `calc(${pos * 100}% + ${(0.5 - pos) * 16}px)`
            this.#paintSlider()
        })
        slider.addEventListener('change', async () => {
            preview.hidden = true
            const { section, fraction } = this.#fractionToLocation(slider.value / 1000)
            await this.pager.display(section, { fraction })
        })
    }

    // ---- chrome & panels ------------------------------------------------

    toast(message, duration = 3000) {
        const el = $('#toast')
        el.textContent = message
        el.hidden = false
        clearTimeout(this.toastTimer)
        this.toastTimer = setTimeout(() => el.hidden = true, duration)
    }

    setChrome(visible) {
        this.chromeVisible = visible
        document.body.classList.toggle('chrome-visible', visible)
        if (!visible) this.#closeSettings()
    }

    get panelOpen() {
        return !$('#toc-panel').hidden || !$('#search-panel').hidden
    }

    openPanel(name) {
        this.closePanels()
        this.#closeSettings()
        const panel = $(`#${name}-panel`)
        panel.hidden = false
        $('#scrim').hidden = false
        this.lastFocus = document.activeElement
        if (name === 'search') {
            $('#search-input').focus()
            $('#search-input').select()
        } else {
            const current = panel.querySelector('[aria-current="true"]')
            current?.scrollIntoView({ block: 'center' })
            ;(current ?? panel.querySelector('[data-close]')).focus({ preventScroll: true })
        }
    }

    closePanels() {
        let closed = false
        for (const panel of document.querySelectorAll('.panel')) {
            if (!panel.hidden) closed = true
            panel.hidden = true
        }
        $('#scrim').hidden = true
        if (closed) this.lastFocus?.focus?.({ preventScroll: true })
        return closed || this.#closeSettings()
    }

    #closeSettings() {
        const open = !$('#settings-panel').hidden
        $('#settings-panel').hidden = true
        $('#settings-button').setAttribute('aria-expanded', 'false')
        return open
    }

    #bindPanels() {
        $('#toc-button').addEventListener('click', () => this.openPanel('toc'))
        $('#search-button').addEventListener('click', () => this.openPanel('search'))
        $('#scrim').addEventListener('click', () => this.closePanels())
        for (const button of document.querySelectorAll('[data-close]'))
            button.addEventListener('click', () => this.closePanels())

        // Keep keyboard focus inside an open panel.
        document.addEventListener('focusin', e => {
            const panel = document.querySelector('.panel:not([hidden])')
            if (panel && !panel.contains(e.target))
                panel.querySelector('input, a, button')?.focus()
        })
    }

    // ---- settings -------------------------------------------------------

    applySettings({ relayout = true } = {}) {
        // Read the position before any style change alters the layout.
        const anchor = relayout && this.pager?.section >= 0 ? this.pager.currentAnchor() : null
        const root = document.documentElement
        root.dataset.theme = settings.theme
        root.dataset.font = settings.font
        root.dataset.ruby = settings.ruby
        root.style.setProperty('--font-size', `${settings.fontSize}px`)
        root.style.setProperty('--line-height', LINE_HEIGHTS[settings.lineHeight] ?? LINE_HEIGHTS.normal)

        for (const group of document.querySelectorAll('.segmented[data-setting]'))
            for (const button of group.querySelectorAll('button'))
                button.setAttribute('aria-pressed', String(button.dataset.value === settings[group.dataset.setting]))
        const i = FONT_SIZES.indexOf(settings.fontSize)
        $('#font-size-value').textContent = `${settings.fontSize}px`
        $('#font-smaller').disabled = i <= 0
        $('#font-larger').disabled = i >= FONT_SIZES.length - 1

        const vertical = settings.writing === 'vertical'
        $('#slider').dir = vertical ? 'rtl' : 'ltr'
        $('#edge-left').setAttribute('aria-label', vertical ? '次のページ' : '前のページ')
        $('#edge-right').setAttribute('aria-label', vertical ? '前のページ' : '次のページ')

        const dark = settings.theme === 'dark'
            || (settings.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches)
        let meta = document.querySelector('meta[name="theme-color"]')
        if (!meta) {
            meta = document.createElement('meta')
            meta.name = 'theme-color'
            document.head.append(meta)
        }
        meta.content = dark ? '#18171b' : settings.theme === 'sepia' ? '#f3ecdb' : '#fbfaf6'

        if (relayout && this.pager) this.pager.relayout({ vertical, anchor })
        persist()
    }

    #bindSettings() {
        const panel = $('#settings-panel')
        const button = $('#settings-button')
        button.addEventListener('click', e => {
            e.stopPropagation()
            const open = panel.hidden
            panel.hidden = !open
            button.setAttribute('aria-expanded', String(open))
        })
        document.addEventListener('pointerdown', e => {
            if (!panel.hidden && !panel.contains(e.target) && !button.contains(e.target)
                && !$('#stage').contains(e.target))
                this.#closeSettings()
        }, true)

        for (const group of document.querySelectorAll('.segmented[data-setting]')) {
            group.addEventListener('click', e => {
                const b = e.target.closest('button[data-value]')
                if (!b) return
                settings[group.dataset.setting] = b.dataset.value
                this.applySettings()
            })
        }
        const step = delta => {
            const i = FONT_SIZES.indexOf(settings.fontSize)
            const current = i < 0 ? FONT_SIZES.findIndex(s => s >= settings.fontSize) : i
            settings.fontSize = FONT_SIZES[Math.max(0, Math.min(FONT_SIZES.length - 1, current + delta))]
            this.applySettings()
        }
        $('#font-smaller').addEventListener('click', () => step(-1))
        $('#font-larger').addEventListener('click', () => step(1))

        matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.applySettings({ relayout: false }))
    }

    // ---- search ---------------------------------------------------------

    #bindSearch() {
        let timer
        $('#search-input').addEventListener('input', () => {
            clearTimeout(timer)
            timer = setTimeout(() => this.runSearch(), 200)
        })
        $('#search-form').addEventListener('submit', e => {
            e.preventDefault()
            clearTimeout(timer)
            this.runSearch()
            $('#search-results button')?.focus()
        })
    }

    runSearch() {
        const query = $('#search-input').value.trim()
        const status = $('#search-status')
        const list = $('#search-results')
        list.replaceChildren()
        if (!query) return status.textContent = ''
        if (!this.index) return status.textContent = '検索の準備をしています…'

        const { results, total } = this.index.search(query)
        status.textContent = total
            ? `${total.toLocaleString('ja-JP')} 件見つかりました${total > results.length ? `（先頭 ${results.length} 件を表示）` : ''}`
            : '見つかりませんでした'

        let lastSection = -1
        for (const hit of results) {
            if (hit.section !== lastSection) {
                lastSection = hit.section
                const group = document.createElement('li')
                group.className = 'result-group'
                group.textContent = this.book.spine[hit.section].title
                list.append(group)
            }
            const li = document.createElement('li')
            const button = document.createElement('button')
            const text = document.createElement('span')
            text.className = 'result-text'
            const mark = document.createElement('mark')
            mark.textContent = hit.match
            text.append(hit.before, mark, hit.after)
            button.append(text)
            button.addEventListener('click', () => this.#showHit(hit))
            li.append(button)
            list.append(li)
        }
    }

    async #showHit(hit) {
        this.closePanels()
        await this.pager.display(hit.section, { anchor: hit.start })
        this.#clearHighlight()
        const range = this.pager.rangeFromAnchors(hit.start, hit.end)
        if (range && globalThis.Highlight && CSS.highlights) {
            CSS.highlights.set('search-hit', new Highlight(range))
            this.#highlightTimer = setTimeout(() => this.#clearHighlight(), 8000)
        }
    }

    #clearHighlight() {
        clearTimeout(this.#highlightTimer)
        CSS.highlights?.delete('search-hit')
    }

    // ---- progress -------------------------------------------------------

    #fractionToLocation(fraction) {
        const total = this.weights.reduce((a, b) => a + b, 0)
        let target = fraction * total
        for (let i = 0; i < this.weights.length; i++) {
            if (target <= this.weights[i] || i === this.weights.length - 1)
                return { section: i, fraction: Math.max(0, Math.min(1, target / this.weights[i])) }
            target -= this.weights[i]
        }
        return { section: 0, fraction: 0 }
    }

    #bookFraction() {
        const { section, page, pages } = this.pager
        const total = this.weights.reduce((a, b) => a + b, 0)
        const before = this.weights.slice(0, section).reduce((a, b) => a + b, 0)
        const within = pages > 1 ? page / (pages - 1) : 1
        return total ? (before + this.weights[section] * within) / total : 0
    }

    #paintSlider() {
        const slider = $('#slider')
        slider.style.setProperty('--fill', `${slider.value / 10}%`)
        slider.style.setProperty('--fill-dir', slider.dir === 'rtl' ? 'to left' : 'to right')
    }

    #updateProgress() {
        const { section, page, pages } = this.pager
        const fraction = this.#bookFraction()
        const slider = $('#slider')
        if (document.activeElement !== slider || $('#slider-preview').hidden)
            slider.value = Math.round(fraction * 1000)
        this.#paintSlider()
        const title = this.book.spine[section].title ?? ''
        const percent = `${Math.round(fraction * 100)}%`
        $('#chapter-label').textContent = title
        $('#progress-label').textContent = `${page + 1} / ${pages} ページ ・ ${percent}`
        $('#running-head').textContent = this.pager.isCover ? '' : title
        $('#folio').textContent = this.pager.isCover ? '' : `${page + 1} / ${pages}`
    }

    #onRelocate({ section }) {
        this.#updateProgress()
        const path = this.book.spine[section].path
        for (const a of document.querySelectorAll('#toc-list a'))
            a.setAttribute('aria-current', String(a.dataset.path === path))
        // Anchors need layout, so compute them after the frame is painted.
        requestAnimationFrame(() => {
            if (this.pager.section !== section) return
            position = { path, anchor: this.pager.currentAnchor() }
            persist()
        })
    }
}

const app = new App()
globalThis.app = app

const boot = () => app.start().catch(e => loader.fail(e))
$('#loader-retry').addEventListener('click', () => location.reload())
boot()
