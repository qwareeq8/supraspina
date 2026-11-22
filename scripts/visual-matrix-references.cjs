/** Discovers local renderer assets referenced from generated output files. */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

/**
 * Extract local renderer references from one generated output file.
 *
 * @param {string} filePath
 * @returns {string[]}
 */
function extractRendererReferences(filePath) {
  const extension = path.extname(filePath).toLowerCase()
  if (!['.css', '.html', '.js', '.mjs', '.svg'].includes(extension)) return []

  const contents = fs.readFileSync(filePath, 'utf8')
  const references = []
  const patterns = []
  if (extension === '.html' || extension === '.svg') {
    patterns.push(/\b(?:href|src)\s*=\s*["']([^"']+)["']/gi)
  }
  if (extension === '.css' || extension === '.svg') {
    patterns.push(/\burl\(\s*(?:["']([^"']+)["']|([^"')\s]+))\s*\)/gi)
  }
  if (extension === '.js' || extension === '.mjs') {
    patterns.push(
      /\bnew URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g,
      /\bimport\(\s*["']([^"']+)["']\s*\)/g,
      /\b(?:import|export)\b[^;"']{0,500}?\bfrom\s*["']([^"']+)["']/g,
      /\bimport\s+["']([^"']+)["']/g,
    )
  }

  for (const pattern of patterns) {
    for (const match of contents.matchAll(pattern)) {
      references.push(match[1] || match[2])
    }
  }
  return references
}

module.exports = { extractRendererReferences }
