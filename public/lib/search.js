// Full-text index over the book's base text (ruby readings excluded, so a
// search for 「学校」 matches 学校《がくかう》). Hits are returned as anchors
// compatible with Pager: { block, offset } with offsets counted over the
// block's full textContent, readings included.

import { getBlocks } from './epub.js'

const SNIPPET = 24

export class SearchIndex {
    sections = [] // per spine item: [{ text, map: Int32Array }] per block

    static async build(book) {
        const index = new SearchIndex()
        for (let i = 0; i < book.spine.length; i++) {
            const doc = await book.loadSection(i)
            index.sections.push(getBlocks(doc.body ?? doc.documentElement).map(indexBlock))
            // Keep the UI responsive while indexing.
            await new Promise(resolve => setTimeout(resolve))
        }
        return index
    }

    // Length of base text per section — a good measure of reading progress.
    get lengths() {
        return this.sections.map(blocks => blocks.reduce((sum, b) => sum + b.text.length, 0))
    }

    search(query, limit = 300) {
        const needle = normalize(query.trim())
        const results = []
        if (!needle) return { results, total: 0 }
        let total = 0
        this.sections.forEach((blocks, section) => blocks.forEach((block, blockIndex) => {
            const haystack = normalize(block.text)
            for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + needle.length)) {
                total++
                if (results.length >= limit) continue
                const end = at + needle.length
                results.push({
                    section,
                    start: { block: blockIndex, offset: block.map[at] },
                    end: { block: blockIndex, offset: block.map[end - 1] + 1 },
                    before: (at > SNIPPET ? '…' : '') + block.text.slice(Math.max(0, at - SNIPPET), at),
                    match: block.text.slice(at, end),
                    after: block.text.slice(end, end + SNIPPET) + (end + SNIPPET < block.text.length ? '…' : ''),
                })
            }
        }))
        return { results, total }
    }
}

function indexBlock(block) {
    let text = ''
    const map = []
    let offset = 0
    const walker = block.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_TEXT)
    for (let node; (node = walker.nextNode());) {
        const hidden = node.parentElement?.closest('rt, rp')
        if (!hidden) {
            for (let i = 0; i < node.data.length; i++) map.push(offset + i)
            text += node.data
        }
        offset += node.data.length
    }
    return { text, map: Int32Array.from(map) }
}

// Width-insensitive, case-insensitive matching that keeps string length intact.
const normalize = s => s.replace(/[Ａ-Ｚａ-ｚ０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).toLowerCase()
