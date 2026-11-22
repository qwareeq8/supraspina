import type { CSSProperties, ReactNode } from 'react'
import icon from '../assets/brand/supraspina_icon.svg'

/** The Supraspina brandmark presentation. */
export interface BrandmarkProps {
  size?: number
  style?: CSSProperties
}

/**
 * Render the Supraspina brandmark.
 *
 * Use the full-color mark on every surface and in every theme so the product
 * identity stays identical wherever it appears.
 */
export function Brandmark({ size = 26, style }: BrandmarkProps): ReactNode {
  return (
    <img
      src={icon}
      alt=""
      height={size}
      style={{ height: size, width: 'auto', display: 'block', ...style }}
    />
  )
}
