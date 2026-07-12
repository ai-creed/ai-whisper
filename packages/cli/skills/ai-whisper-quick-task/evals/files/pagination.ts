export function pageCount(total: number, perPage: number): number {
  return Math.ceil(total / perPage)
}
