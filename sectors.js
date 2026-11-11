/**
 * 品种板块与交易时段（趋势雷达共用）
 *
 * 原来放在引擎里，随爆发逻辑一起退役；趋势策略只需要板块归属。
 */

export const SECTOR_MAP = {
  股指: ['IF', 'IH', 'IC', 'IM'],
  国债: ['TS', 'TF', 'T', 'TL'],
  贵金属: ['AU', 'AG'],
  有色: ['CU', 'AL', 'ZN', 'PB', 'NI', 'SN', 'SS', 'BC', 'AO', 'AD'],
  黑色: ['RB', 'HC', 'I', 'J', 'JM', 'SF', 'SM'],
  能化: [
    'SC', 'FU', 'BU', 'RU', 'NR', 'BR', 'SP', 'LU', 'PX', 'PR', 'EB', 'PP', 'L', 'PG', 'V',
    'MA', 'TA', 'EG', 'UR', 'SA', 'FG', 'BZ', 'PT', 'PL',
  ],
  农产品: [
    'M', 'Y', 'A', 'B', 'P', 'C', 'CS', 'JD', 'LH', 'RR', 'OI', 'RM', 'CF', 'CY', 'SR',
    'AP', 'CJ', 'PK', 'RS', 'WH', 'PM', 'RI', 'LR', 'JR', 'FB',
  ],
  新兴: ['LC', 'SI', 'PS', 'SH', 'EC', 'LG', 'OP', 'PD', 'PF'],
}

const VARIETY_SECTOR = (() => {
  const m = new Map()
  for (const [sector, list] of Object.entries(SECTOR_MAP)) for (const v of list) m.set(v, sector)
  return m
})()

export function varietyOf(code) {
  return String(code).replace(/\d+$/, '').toUpperCase()
}

/** 品种所属板块；未归类归为「其他」 */
export function sectorOf(code) {
  return VARIETY_SECTOR.get(varietyOf(code)) || '其他'
}
