/**
 * AUTO-GENERATED - DO NOT EDIT MANUALLY
 * Generated from drip-pool contract spec v1.0.0
 */

export interface DepositArgs {
  vaultId: string;
  user: string;
  amount: string;
}

export interface WithdrawArgs {
  vaultId: string;
  user: string;
  amount: string;
}

export interface SettleArgs {
  vaultId: string;
  settlementType: "release" | "distribute" | "refund";
  recipient?: string;
  amount?: string;
}

export class DripPoolContractClient {
  constructor(
    public readonly contractId: string,
    public readonly networkPassphrase: string
  ) {}

  public encodeDeposit(args: DepositArgs): string {
    if (!args.vaultId || !args.user || !args.amount) {
      throw new Error("Invalid deposit arguments");
    }
    return `xdr:deposit:${args.vaultId}:${args.user}:${args.amount}`;
  }

  public encodeWithdraw(args: WithdrawArgs): string {
    if (!args.vaultId || !args.user || !args.amount) {
      throw new Error("Invalid withdraw arguments");
    }
    return `xdr:withdraw:${args.vaultId}:${args.user}:${args.amount}`;
  }

  public encodeSettle(args: SettleArgs): string {
    if (!args.vaultId || !args.settlementType) {
      throw new Error("Invalid settle arguments");
    }
    return `xdr:settle:${args.vaultId}:${args.settlementType}:${args.recipient || ""}:${args.amount || "0"}`;
  }
}
