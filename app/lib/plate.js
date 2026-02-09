// 1. 拉行业板块实时行情
getIndustryPlates(): Promise<Array<{code, name, pct}>>

// 2. 拉板块成分股（用于映射）
getPlateStocks(bkCode): Promise<string[]>
