// EPUB 3 package reader: container → OPF (metadata/manifest/spine) → nav (TOC).
// Also prepares the book's stylesheets (scoped to `.epub-body`) and fonts.

import { ZipArchive } from './zip.js'

const NS = {
    container: 'urn:oasis:names:tc:opendocument:xmlns:container',
    opf: 'http://www.idpf.org/2007/opf',
    dc: 'http://purl.org/dc/elements/1.1/',
    xhtml: 'http://www.w3.org/1999/xhtml',
    epub: 'http://www.idpf.org/2007/ops',
}

// Leaf-level text blocks used for reading positions and search hits.
// The same selection is applied to parsed sections and rendered content,
// so indices are stable between the two.
const BLOCK_SELECTOR = 'p,h1,h2,h3,h4,h5,h6,li,dt,dd,pre,th,td,figcaption,caption,img'

export const getBlocks = root => Array.from(root.querySelectorAll(BLOCK_SELECTOR))
    .filter(el => el.localName === 'img' || !el.querySelector(BLOCK_SELECTOR))

const parseXML = (text, type = 'application/xml') => {
    const doc = new DOMParser().parseFromString(text, type)
    if (doc.querySelector('parsererror')) {
        // Fall back to the forgiving HTML parser for malformed XHTML.
        if (type === 'application/xhtml+xml') return new DOMParser().parseFromString(text, 'text/html')
        throw new Error('XMLの解析に失敗しました')
    }
    return doc
}

const dirname = path => path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : ''

// Resolve `href` relative to the file at `base` (both are paths inside the zip).
export const resolvePath = (href, base = '') => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return href
    const [pathPart] = href.split('#')
    const segments = (pathPart.startsWith('/') ? pathPart.slice(1) : dirname(base) + pathPart).split('/')
    const out = []
    for (const seg of segments) {
        if (seg === '..') out.pop()
        else if (seg !== '.' && seg !== '') out.push(seg)
    }
    return out.map(decodeURIComponent).join('/')
}

const fragmentOf = href => {
    const i = href.indexOf('#')
    return i < 0 ? '' : decodeURIComponent(href.slice(i + 1))
}

const text = el => el?.textContent.trim() ?? ''

// Split a selector list on top-level commas (ignores commas inside parentheses).
const splitSelectors = selectorText => {
    const parts = []
    let depth = 0, current = ''
    for (const ch of selectorText) {
        if (ch === '(') depth++
        else if (ch === ')') depth--
        if (ch === ',' && depth === 0) {
            parts.push(current.trim())
            current = ''
        } else current += ch
    }
    if (current.trim()) parts.push(current.trim())
    return parts
}

const scopeSelector = (selector, scope) => {
    if (/^(html|body)\b/i.test(selector)) return selector.replace(/^(html\s*)?(body)?/i, scope)
    if (/^:root\b/.test(selector)) return selector.replace(/^:root/, scope)
    return `${scope} ${selector}`
}

export class Book {
    #zip
    #opfPath
    #sectionCache = new Map()
    #blobURLs = new Map()

    metadata = {}
    manifest = new Map() // path → { id, href, type, properties }
    spine = []           // { path, linear, title, size }
    toc = []             // { label, path, fragment, children }
    direction = 'ltr'
    coverPath = null
    css = ''             // scoped stylesheet text
    fonts = []           // { family, weight, style, path }

    static async open(buffer) {
        const book = new Book()
        await book.#init(new ZipArchive(buffer))
        return book
    }

    async #init(zip) {
        this.#zip = zip
        const container = parseXML(await zip.text('META-INF/container.xml'))
        const rootfile = container.getElementsByTagNameNS(NS.container, 'rootfile')[0]
        this.#opfPath = rootfile.getAttribute('full-path')
        const opf = parseXML(await zip.text(this.#opfPath))

        this.#readMetadata(opf)
        this.#readManifest(opf)
        this.#readSpine(opf)
        await this.#readTOC()
        await this.#readStyles()

        for (const item of this.spine) {
            item.title = this.#titleForPath(item.path)
            item.size = zip.size(item.path)
        }
    }

    #readMetadata(opf) {
        const md = opf.getElementsByTagNameNS(NS.opf, 'metadata')[0]
        const dc = name => Array.from(md.getElementsByTagNameNS(NS.dc, name))
        const refines = (el, property) => {
            const id = el.getAttribute('id')
            if (!id) return null
            return Array.from(md.getElementsByTagNameNS(NS.opf, 'meta'))
                .find(m => m.getAttribute('refines') === `#${id}` && m.getAttribute('property') === property)
                ?.textContent.trim() ?? null
        }
        this.metadata = {
            title: text(dc('title')[0]),
            language: text(dc('language')[0]),
            identifier: text(dc('identifier')[0]),
            creators: dc('creator').map(el => ({ name: text(el), role: refines(el, 'role') })),
            contributors: dc('contributor').map(el => ({ name: text(el), role: refines(el, 'role') })),
        }
    }

    #readManifest(opf) {
        for (const item of opf.getElementsByTagNameNS(NS.opf, 'item')) {
            const path = resolvePath(item.getAttribute('href'), this.#opfPath)
            this.manifest.set(path, {
                id: item.getAttribute('id'),
                path,
                type: item.getAttribute('media-type'),
                properties: (item.getAttribute('properties') ?? '').split(/\s+/),
            })
        }
        const items = [...this.manifest.values()]
        const coverId = Array.from(opf.getElementsByTagNameNS(NS.opf, 'meta'))
            .find(m => m.getAttribute('name') === 'cover')?.getAttribute('content')
        this.coverPath = (items.find(i => i.properties.includes('cover-image'))
            ?? items.find(i => i.id === coverId))?.path ?? null
    }

    #readSpine(opf) {
        const spine = opf.getElementsByTagNameNS(NS.opf, 'spine')[0]
        this.direction = spine.getAttribute('page-progression-direction') === 'rtl' ? 'rtl' : 'ltr'
        const byId = new Map([...this.manifest.values()].map(i => [i.id, i]))
        for (const ref of spine.getElementsByTagNameNS(NS.opf, 'itemref')) {
            const item = byId.get(ref.getAttribute('idref'))
            if (!item) continue
            this.spine.push({ path: item.path, linear: ref.getAttribute('linear') !== 'no' })
        }
    }

    async #readTOC() {
        const nav = [...this.manifest.values()].find(i => i.properties.includes('nav'))
        if (!nav) return
        const doc = parseXML(await this.#zip.text(nav.path), 'application/xhtml+xml')
        const tocNav = Array.from(doc.getElementsByTagNameNS(NS.xhtml, 'nav'))
            .find(el => (el.getAttributeNS(NS.epub, 'type') ?? '').split(/\s+/).includes('toc'))
        const parseList = ol => Array.from(ol?.children ?? [])
            .filter(li => li.localName === 'li')
            .map(li => {
                const a = Array.from(li.children).find(el => el.localName === 'a' || el.localName === 'span')
                const href = a?.getAttribute('href')
                return {
                    label: text(a),
                    path: href ? resolvePath(href, nav.path) : null,
                    fragment: href ? fragmentOf(href) : '',
                    children: parseList(Array.from(li.children).find(el => el.localName === 'ol')),
                }
            })
        this.toc = parseList(Array.from(tocNav?.children ?? []).find(el => el.localName === 'ol'))
        this.navPath = nav.path
    }

    #titleForPath(path) {
        const find = items => {
            for (const item of items) {
                if (item.path === path) return item.label
                const found = find(item.children)
                if (found) return found
            }
            return null
        }
        if (path === this.navPath) return '目次'
        return find(this.toc)
    }

    async #readStyles() {
        const scope = '.epub-body'
        const out = []
        for (const item of this.manifest.values()) {
            if (item.type !== 'text/css') continue
            const sheet = new CSSStyleSheet()
            sheet.replaceSync(await this.#zip.text(item.path))
            const convert = rules => {
                for (const rule of rules) {
                    if (rule instanceof CSSFontFaceRule) {
                        const src = rule.style.getPropertyValue('src').match(/url\(\s*['"]?([^'")]+)['"]?\s*\)/)
                        if (!src) continue
                        this.fonts.push({
                            family: rule.style.getPropertyValue('font-family').replace(/^['"]|['"]$/g, ''),
                            weight: rule.style.getPropertyValue('font-weight') || 'normal',
                            style: rule.style.getPropertyValue('font-style') || 'normal',
                            path: resolvePath(src[1], item.path),
                        })
                    } else if (rule instanceof CSSStyleRule) {
                        if (!rule.style.length) continue
                        const selector = splitSelectors(rule.selectorText)
                            .map(s => scopeSelector(s, scope)).join(', ')
                        out.push(`${selector} { ${rule.style.cssText} }`)
                    } else if (rule instanceof CSSMediaRule) {
                        out.push(`@media ${rule.conditionText} {`)
                        convert(rule.cssRules)
                        out.push('}')
                    }
                }
            }
            convert(sheet.cssRules)
        }
        this.css = out.join('\n')
    }

    async loadFonts() {
        const faces = await Promise.all(this.fonts.map(async f => {
            const face = new FontFace(f.family, await this.#zip.bytes(f.path), {
                weight: f.weight === 'bold' ? '700' : f.weight === 'normal' ? '400' : f.weight,
                style: f.style,
            })
            await face.load()
            document.fonts.add(face)
            return face
        }))
        return faces
    }

    async resourceURL(path) {
        if (!this.#blobURLs.has(path)) {
            const type = this.manifest.get(path)?.type ?? ''
            this.#blobURLs.set(path, this.#zip.blob(path, type).then(URL.createObjectURL))
        }
        return this.#blobURLs.get(path)
    }

    // Returns the parsed XHTML document for a spine item (cached).
    async loadSection(index) {
        const { path } = this.spine[index]
        if (!this.#sectionCache.has(path)) {
            this.#sectionCache.set(path, (async () => {
                const doc = parseXML(await this.#zip.text(path), 'application/xhtml+xml')
                for (const el of doc.querySelectorAll('script')) el.remove()
                return doc
            })())
        }
        return this.#sectionCache.get(path)
    }

    // Builds a fragment ready to be inserted into the reader document.
    async renderSection(index) {
        const { path } = this.spine[index]
        const doc = await this.loadSection(index)
        const source = doc.body ?? doc.getElementsByTagNameNS(NS.xhtml, 'body')[0]
        // Rewrite image sources on a detached copy: images start loading as soon
        // as they are imported into the reader document.
        const body = source.cloneNode(true)
        await Promise.all(Array.from(body.querySelectorAll('img[src]'), async img => {
            const target = resolvePath(img.getAttribute('src'), path)
            if (this.manifest.has(target)) img.setAttribute('src', await this.resourceURL(target))
            else img.removeAttribute('src')
        }))
        const fragment = document.createDocumentFragment()
        for (const node of body.childNodes) fragment.append(document.importNode(node, true))
        for (const a of fragment.querySelectorAll('a[href]')) {
            const href = a.getAttribute('href')
            if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
                a.target = '_blank'
                a.rel = 'noopener noreferrer'
            } else {
                a.dataset.path = href.startsWith('#') ? path : resolvePath(href, path)
                a.dataset.fragment = fragmentOf(href)
            }
        }
        const isCover = (body.getAttributeNS(NS.epub, 'type') ?? '').includes('cover')
            || (fragment.querySelectorAll('img').length === 1 && !fragment.textContent.trim())
        return {
            fragment,
            lang: doc.documentElement.getAttribute('xml:lang') || doc.documentElement.lang || this.metadata.language,
            isCover,
        }
    }

    spineIndexOf(path) {
        return this.spine.findIndex(s => s.path === path)
    }
}
