/**
 * Decides which neighbours a phone links to. Nearby Connections moves bytes
 * between two phones but does no routing, and phones hold about 3 or 4 radio
 * links in practice (a Bluetooth helmet takes one), so a group of 8 cannot all
 * link to each other. Each phone keeps a few links and riders reach the rest
 * through their neighbours.
 */
export const SOFT_LINKS = 3;
export const HARD_LINKS = 4;
/** Silent for this long means no longer reachable. */
export const REACHABLE_MS = 12_000;
/** Heavy radio work breaks links, so scanning stops once things have settled. */
export const SETTLE_MS = 30_000;
/**
 * The last link slot is kept for joining a split group. It waits this long so the
 * mesh can learn who is reachable: at first everyone looks out of reach, and
 * spending the slot then lets a few riders fill up and strand the others.
 */
export const BRIDGE_WAIT_MS = 8_000;
/**
 * A settled group still has to notice another group riding up, or two halves of
 * a split ride would stay apart for good. Only one side needs to scan, because
 * every phone keeps advertising, so each takes a short look at its own moment.
 */
export const RESCAN_EVERY_MS = 120_000;
export const RESCAN_FOR_MS = 8_000;

export class MeshRouter {
  private readonly heardAt = new Map<number, number>();
  private links = new Set<string>();
  private changedAt: number;
  private linksChangedAt: number;
  private lastReachable = 0;

  constructor(
    private readonly self: number,
    private readonly now: () => number = Date.now,
  ) {
    this.changedAt = this.linksChangedAt = now();
  }

  setLinks(endpoints: string[]): void {
    if (endpoints.length !== this.links.size) this.changedAt = this.linksChangedAt = this.now();
    this.links = new Set(endpoints);
  }

  isLinked(endpoint: string): boolean {
    return this.links.has(endpoint);
  }

  get linkCount(): number {
    return this.links.size;
  }

  /** Any packet from a rider, however many hops it took, proves they are reachable. */
  heard(rider: number): void {
    this.heardAt.set(rider, this.now());
  }

  reachable(): number[] {
    const cutoff = this.now() - REACHABLE_MS;
    const riders: number[] = [];
    for (const [rider, at] of this.heardAt) {
      if (at >= cutoff) riders.push(rider);
      else this.heardAt.delete(rider);
    }
    if (riders.length !== this.lastReachable) {
      this.lastReachable = riders.length;
      this.changedAt = this.now();
    }
    return riders;
  }

  /** Whether to request a link to a phone just found. */
  shouldDial(peer: number): boolean {
    if (this.links.size >= HARD_LINKS) return false;
    const known = this.reachable().includes(peer);
    if (this.links.size < SOFT_LINKS) {
      // Lower id dials, so two phones do not call each other at the same moment.
      return !known || this.self < peer;
    }
    // At the usual limit, only a settled mesh that still cannot reach them has really split.
    return !known && this.now() - this.linksChangedAt >= BRIDGE_WAIT_MS;
  }

  /** Whether to keep scanning. Off once settled, since scanning disturbs the links in use. */
  shouldDiscover(): boolean {
    this.reachable();
    if (this.links.size === 0 || this.now() - this.changedAt < SETTLE_MS) return true;
    if (this.links.size >= HARD_LINKS) return false; // Could not dial anyone it found.
    return (this.now() + this.self * 1009) % RESCAN_EVERY_MS < RESCAN_FOR_MS;
  }

  canAccept(): boolean {
    return this.links.size < HARD_LINKS;
  }
}
