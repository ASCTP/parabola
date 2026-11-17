export class InvalidIndexerRangeError extends Error {
  constructor(fromBlock: bigint, toBlock: bigint) {
    super(
      `Invalid indexer block range: fromBlock ${fromBlock} is greater than toBlock ${toBlock}`,
    );
    this.name = new.target.name;
  }
}

export class InvalidLedgerRangeError extends Error {
  constructor(startLedger: number, endLedger: number) {
    super(
      `Invalid indexer ledger range: startLedger ${startLedger} is greater than endLedger ${endLedger}`,
    );
    this.name = new.target.name;
  }
}

export class InvalidIndexerCursorError extends Error {
  constructor(message: string) {
    super(`Invalid indexer cursor: ${message}`);
    this.name = new.target.name;
  }
}

export class IndexerCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
