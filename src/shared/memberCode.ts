export function createMemberCode(memberId: string): string {
  return memberId.replace(/-/g, '').slice(0, 8).toUpperCase();
}
