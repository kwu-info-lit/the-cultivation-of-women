// Paginates one section at a time using CSS multi-column layout.
//
// The content element is a multicol container whose column size equals the
// page size, so the browser's own fragmentation decides page breaks and a
// line is never cut in half. Overflow columns are stacked along the inline
// axis — downwards for vertical-rl, rightwards for horizontal-tb — and a page
// is shown by translating the content by `page * step` inside a clipping
// viewport. The gap between columns doubles as the page margin.
//
// Reading positions are stored as anchors { block, offset }: the index of a
// leaf text block (see getBlocks) and a character offset in its textContent.
// Anchors survive relayouts (font size, window size, writing mode).

import { getBlocks } from './epub.js'

const isHidden = node => node.parentElement?.closest('rt, rp')

export class Pager extends EventTarget {
    stage
    viewport
    content
    book
    vertical = true
    section = -1
    page = 0
    pages = 1
    isCover = false

    #geometry
    #blocks = []
    #nodeCache = new Map()
    #anchor = null // position to keep across relayouts; null = derive from page
    #end
    #range = document.createRange()
    #renderToken = 0

    constructor({ stage, viewport, content, book }) {
        super()
        Object.assign(this, { stage, viewport, content, book })
        // Browser find-in-page or focus can scroll a clipping box; undo it.
        viewport.addEventListener('scroll', () => viewport.scrollTo(0, 0))
    }

    get atStart() {
        return this.section <= 0 && this.page <= 0
    }

    get atEnd() {
        return this.section >= this.book.spine.length - 1 && this.page >= this.pages - 1
    }

    // ---- navigation -------------------------------------------------------

    async display(section, target = { page: 0 }) {
        section = Math.max(0, Math.min(section, this.book.spine.length - 1))
        if (section !== this.section) await this.#render(section)
        this.#goTo(target)
    }

    async next() {
        if (this.page < this.pages - 1) return this.#setPage(this.page + 1)
        if (this.section < this.book.spine.length - 1) return this.display(this.section + 1, { page: 0 })
    }

    async prev() {
        if (this.page > 0) return this.#setPage(this.page - 1)
        if (this.section > 0) return this.display(this.section - 1, { page: 'last' })
    }

    // Re-measure after a change of viewport size, typography or writing mode.
    // The anchor is taken from the old layout before anything changes.
    // Callers that change styles first should pass the anchor they read earlier.
    relayout({ vertical = this.vertical, anchor = null } = {}) {
        if (this.section < 0) {
            this.vertical = vertical
            return
        }
        anchor ??= this.currentAnchor()
        this.vertical = vertical
        this.#applyGeometry()
        this.#measure()
        this.#goTo(anchor ? { anchor } : { page: 0 })
    }

    // ---- rendering --------------------------------------------------------

    async #render(section) {
        const token = ++this.#renderToken
        const { fragment, lang, isCover } = await this.book.renderSection(section)
        if (token !== this.#renderToken) return

        this.content.style.visibility = 'hidden'
        this.content.replaceChildren(fragment)
        this.content.lang = lang ?? ''
        this.isCover = isCover
        this.content.classList.toggle('is-cover', isCover)
        this.#end = document.createElement('div')
        this.#end.className = 'pager-end'
        this.#end.setAttribute('aria-hidden', 'true')
        this.content.append(this.#end)

        this.section = section
        this.#blocks = getBlocks(this.content)
        this.#nodeCache.clear()
        await Promise.all(Array.from(this.content.querySelectorAll('img'), img => img.decode().catch(() => {})))
        this.#applyGeometry()
        this.#measure()
        this.content.style.visibility = ''
    }

    #computeGeometry() {
        const W = this.stage.clientWidth
        const H = this.stage.clientHeight
        const compact = W < 640 || H < 560
        const fontSize = parseFloat(getComputedStyle(this.content).fontSize) || 18
        const my = compact ? 44 : 60 // room for the running head and folio
        if (this.vertical) {
            // Lines run top to bottom; very wide screens get a centred text block.
            const mx = Math.round(Math.max(compact ? 20 : 48, (W - 1400) / 2))
            const cw = W - 2 * mx
            const ch = H - 2 * my
            return { vx: mx, vy: 0, vw: cw, vh: H, cx: 0, cy: my, cw, ch, column: ch, gap: 2 * my, step: H }
        }
        const maxLine = Math.round(fontSize * 38)
        const mx = Math.round(Math.max(compact ? 20 : 48, (W - maxLine) / 2))
        const cw = W - 2 * mx
        const ch = H - 2 * my
        return { vx: 0, vy: my, vw: W, vh: ch, cx: mx, cy: 0, cw, ch, column: cw, gap: 2 * mx, step: W }
    }

    #applyGeometry() {
        const g = this.#geometry = this.#computeGeometry()
        Object.assign(this.viewport.style, {
            left: `${g.vx}px`, top: `${g.vy}px`, width: `${g.vw}px`, height: `${g.vh}px`,
        })
        Object.assign(this.content.style, {
            left: `${g.cx}px`, top: `${g.cy}px`, width: `${g.cw}px`, height: `${g.ch}px`,
            columnWidth: this.isCover ? '' : `${g.column}px`,
            columnGap: this.isCover ? '' : `${g.gap}px`,
        })
        this.content.style.setProperty('--page-width', `${g.cw}px`)
        this.content.style.setProperty('--page-height', `${g.ch}px`)
        this.content.classList.toggle('vertical', this.vertical)
    }

    #measure() {
        this.pages = this.isCover ? 1 : Math.max(1, (this.#pageOfRect(this.#end.getClientRects()[0]) ?? 0) + 1)
    }

    #goTo(target) {
        let page = 0
        if (target.page === 'last') page = this.pages - 1
        else if (typeof target.page === 'number') page = target.page
        else if (typeof target.fraction === 'number') page = Math.round(target.fraction * (this.pages - 1))
        else if (target.anchor) page = this.pageOfAnchor(target.anchor)
        else if (target.fragment) {
            const el = this.content.querySelector(`#${CSS.escape(target.fragment)}`)
            page = this.#pageOfRect(el?.getClientRects()[0] ?? el?.parentElement?.getClientRects()[0]) ?? 0
        }
        this.#setPage(page, target.anchor ?? null)
    }

    #setPage(page, anchor = null) {
        this.page = Math.max(0, Math.min(page, this.pages - 1))
        this.#anchor = anchor
        const offset = -this.page * this.#geometry.step
        this.content.style.transform = this.vertical
            ? `translate3d(0, ${offset}px, 0)` : `translate3d(${offset}px, 0, 0)`
        this.dispatchEvent(new CustomEvent('relocate', {
            detail: { section: this.section, page: this.page, pages: this.pages },
        }))
    }

    // ---- geometry helpers -------------------------------------------------

    #pageOfRect(rect) {
        if (!rect) return null
        const base = this.content.getBoundingClientRect()
        const pos = this.vertical ? rect.top - base.top : rect.left - base.left
        return Math.max(0, Math.floor((pos + 1) / this.#geometry.step))
    }

    #textNodes(blockIndex) {
        if (!this.#nodeCache.has(blockIndex)) {
            const nodes = []
            const walker = document.createTreeWalker(this.#blocks[blockIndex], NodeFilter.SHOW_TEXT)
            let start = 0
            for (let node; (node = walker.nextNode());) {
                const length = node.data.length
                if (!isHidden(node) && node.data.trim()) nodes.push({ node, start, length })
                start += length
            }
            this.#nodeCache.set(blockIndex, nodes)
        }
        return this.#nodeCache.get(blockIndex)
    }

    #pageOfChar(node, offset) {
        this.#range.setStart(node, offset)
        this.#range.setEnd(node, Math.min(offset + 1, node.data.length))
        return this.#pageOfRect(this.#range.getClientRects()[0])
    }

    #blockStartPage(i) {
        const block = this.#blocks[i]
        const first = this.#textNodes(i)[0]
        return (first ? this.#pageOfChar(first.node, 0) : null)
            ?? this.#pageOfRect(block.getClientRects()[0])
    }

    #blockEndPage(i) {
        const nodes = this.#textNodes(i)
        const last = nodes[nodes.length - 1]
        if (!last) return this.#blockStartPage(i)
        return this.#pageOfChar(last.node, last.node.data.length - 1) ?? this.#blockStartPage(i)
    }

    // First (index) in [lo, hi) for which predicate is true; hi if none.
    #search(lo, hi, predicate) {
        while (lo < hi) {
            const mid = (lo + hi) >> 1
            if (predicate(mid)) hi = mid
            else lo = mid + 1
        }
        return lo
    }

    // First visible character in block i on or after `page`.
    #anchorInBlock(i, page) {
        const nodes = this.#textNodes(i)
        const n = this.#search(0, nodes.length, k => {
            const { node } = nodes[k]
            return (this.#pageOfChar(node, node.data.length - 1) ?? -1) >= page
        })
        if (n >= nodes.length) return null
        const { node, start } = nodes[n]
        const offset = this.#search(0, node.data.length, k => (this.#pageOfChar(node, k) ?? -1) >= page)
        return { block: i, offset: start + offset }
    }

    // Anchor of the first character shown on the current page.
    currentAnchor() {
        if (this.#anchor) return this.#anchor
        const count = this.#blocks.length
        if (!count || this.isCover) return { block: 0, offset: 0 }
        const page = this.page
        // First block starting on or after this page…
        const first = this.#search(0, count, i => (this.#blockStartPage(i) ?? page) >= page)
        // …unless the block before it spills over onto this page.
        const prev = first - 1
        if (prev >= 0 && this.#blockEndPage(prev) >= page)
            return this.#anchorInBlock(prev, page) ?? { block: Math.min(first, count - 1), offset: 0 }
        return { block: Math.min(first, count - 1), offset: 0 }
    }

    // Locate an anchor in the rendered content as { node, offset } (visible text only).
    #locate({ block, offset }) {
        const nodes = this.#textNodes(block)
        const hit = nodes.find(n => offset < n.start + n.length)
        if (!hit) {
            const last = nodes[nodes.length - 1]
            return last ? { node: last.node, offset: last.length } : null
        }
        return { node: hit.node, offset: Math.max(0, offset - hit.start) }
    }

    pageOfAnchor(anchor) {
        const block = Math.max(0, Math.min(anchor.block ?? 0, this.#blocks.length - 1))
        if (!this.#blocks.length || this.isCover) return 0
        const pos = this.#locate({ block, offset: anchor.offset ?? 0 })
        const page = pos && pos.offset < pos.node.data.length ? this.#pageOfChar(pos.node, pos.offset) : null
        return page ?? this.#blockStartPage(block) ?? 0
    }

    rangeFromAnchors(start, end) {
        const a = this.#locate(start)
        const b = this.#locate(end)
        if (!a || !b) return null
        const range = document.createRange()
        range.setStart(a.node, a.offset)
        range.setEnd(b.node, b.offset)
        return range
    }
}
