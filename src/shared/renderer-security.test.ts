import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DEVELOPMENT_RENDERER_CSP,
  DEFAULT_DEVELOPMENT_RENDERER_URL,
  PRODUCTION_RENDERER_CSP,
  developmentRendererCsp,
  normalizeDevelopmentRendererUrl,
  replaceManagedRendererCsp,
  withRendererCsp,
} from './renderer-security'

const REQUIRED_NONE_DIRECTIVES = [
  "base-uri 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "connect-src 'none'",
]

describe('renderer security contract', () => {
  it('keeps the checked-in renderer HTML on the production policy', () => {
    const html = readFileSync(
      join(process.cwd(), 'src', 'renderer', 'index.html'),
      'utf8',
    )
    const secured = replaceManagedRendererCsp(html, PRODUCTION_RENDERER_CSP)

    expect(secured).toBe(html)
    const development = replaceManagedRendererCsp(
      html,
      DEFAULT_DEVELOPMENT_RENDERER_CSP,
    )
    expect(development).toContain("connect-src 'self' ws://127.0.0.1:5173")
    expect(development).not.toContain("connect-src 'none'")
    for (const directive of REQUIRED_NONE_DIRECTIVES) {
      expect(PRODUCTION_RENDERER_CSP).toContain(directive)
    }
    expect(PRODUCTION_RENDERER_CSP).not.toMatch(/\b(?:https?|wss?):\/\//)
    expect(PRODUCTION_RENDERER_CSP).not.toContain(
      "script-src 'self' 'unsafe-inline'",
    )
  })

  it('generates a separate minimal policy for the exact HTTP or HTTPS HMR endpoint', () => {
    expect(DEFAULT_DEVELOPMENT_RENDERER_URL).toBe('http://127.0.0.1:5173/')
    expect(DEFAULT_DEVELOPMENT_RENDERER_CSP).toContain(
      "connect-src 'self' ws://127.0.0.1:5173",
    )
    expect(developmentRendererCsp('https://[::1]:5173/')).toContain(
      "connect-src 'self' wss://[::1]:5173",
    )
    expect(DEFAULT_DEVELOPMENT_RENDERER_CSP).toContain(
      "script-src 'self' 'unsafe-inline'",
    )
    expect(DEFAULT_DEVELOPMENT_RENDERER_CSP).not.toContain("connect-src 'none'")
  })

  it('accepts only credential-free loopback roots on the fixed port', () => {
    for (const value of [
      'http://127.0.0.1:5173',
      'https://127.0.0.1:5173/',
      'http://localhost:5173/',
      'https://[::1]:5173/',
    ]) {
      expect(normalizeDevelopmentRendererUrl(value)).toBe(new URL(value).href)
    }

    for (const value of [
      '',
      'not a URL',
      'file:///tmp/index.html',
      'ws://127.0.0.1:5173/',
      'http://example.test:5173/',
      'http://127.0.0.2:5173/',
      'http://user@127.0.0.1:5173/',
      'http://127.0.0.1:5174/',
      'http://127.0.0.1/',
      'http://127.0.0.1:5173/other',
      'http://127.0.0.1:5173/?query=1',
      'http://127.0.0.1:5173/#fragment',
    ]) {
      expect(() => normalizeDevelopmentRendererUrl(value)).toThrow(
        /development (?:renderer )?URL/,
      )
    }
  })

  it('fails closed if the managed CSP element drifts or a policy could escape its attribute', () => {
    const valid =
      '<meta content="old" data-supraspina-csp="managed"><main></main>'
    expect(replaceManagedRendererCsp(valid, "default-src 'none'")).toBe(
      '<meta content="default-src \'none\'" data-supraspina-csp="managed"><main></main>',
    )
    expect(() =>
      replaceManagedRendererCsp('<main></main>', PRODUCTION_RENDERER_CSP),
    ).toThrow(/one managed CSP/)
    expect(() =>
      replaceManagedRendererCsp(`${valid}${valid}`, PRODUCTION_RENDERER_CSP),
    ).toThrow(/one managed CSP/)
    expect(() =>
      replaceManagedRendererCsp(
        '<div data-supraspina-csp="managed">',
        PRODUCTION_RENDERER_CSP,
      ),
    ).toThrow(/well-formed/)
    expect(() =>
      replaceManagedRendererCsp(
        '<meta data-supraspina-csp="managed">',
        PRODUCTION_RENDERER_CSP,
      ),
    ).toThrow(/one content attribute/)
    expect(() =>
      replaceManagedRendererCsp(
        '<meta content="one" content="two" data-supraspina-csp="managed">',
        PRODUCTION_RENDERER_CSP,
      ),
    ).toThrow(/one content attribute/)
    expect(() => replaceManagedRendererCsp(valid, '')).toThrow(/safely/)
    expect(() =>
      replaceManagedRendererCsp(valid, 'default-src "none"'),
    ).toThrow(/safely/)
  })

  it('replaces case-variant response policies without mutating other headers', () => {
    const original = {
      'content-security-policy': ["default-src 'unsafe-inline'"],
      'Content-Security-Policy': ['connect-src *'],
      'X-Content-Type-Options': ['nosniff'],
    }
    expect(withRendererCsp(original, PRODUCTION_RENDERER_CSP)).toEqual({
      'Content-Security-Policy': [PRODUCTION_RENDERER_CSP],
      'X-Content-Type-Options': ['nosniff'],
    })
    expect(original).toEqual({
      'content-security-policy': ["default-src 'unsafe-inline'"],
      'Content-Security-Policy': ['connect-src *'],
      'X-Content-Type-Options': ['nosniff'],
    })
    expect(withRendererCsp(undefined, PRODUCTION_RENDERER_CSP)).toEqual({
      'Content-Security-Policy': [PRODUCTION_RENDERER_CSP],
    })
    expect(
      withRendererCsp(
        { 'X-Content-Type-Options': 'nosniff' },
        PRODUCTION_RENDERER_CSP,
      ),
    ).toEqual({
      'Content-Security-Policy': [PRODUCTION_RENDERER_CSP],
      'X-Content-Type-Options': 'nosniff',
    })
  })
})
