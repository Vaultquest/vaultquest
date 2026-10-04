import React from "react";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectedPublicKey } from "@vaultquest/stellar-wallet-connect/src/core/store";
import { FileSupportTicketStore } from "../../lib/support-ticket-store";
import SupportWidget from "./SupportWidget";

const DESCRIPTION = "My withdrawal has not arrived after the completed round.";
const EDITED_DESCRIPTION = "The withdrawal arrived, but the prize receipt is missing.";

function deferred() {
  let resolve;
  const promise = new Promise((release) => { resolve = release; });
  return { promise, resolve };
}

describe("SupportWidget durable retries", () => {
  let directory;
  let filePath;
  let store;
  let requests;
  let deliver;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "vaultquest-widget-"));
    filePath = path.join(directory, "tickets.jsonl");
    store = new FileSupportTicketStore(filePath);
    requests = [];
    deliver = async (response) => response;
    connectedPublicKey.set("");

    // Only the transport is controlled. Validation, duplicate lookup, receipts,
    // and persistence use the production JSONL store.
    vi.stubGlobal("fetch", vi.fn(async (_url, options) => {
      const input = JSON.parse(options.body);
      requests.push(input);
      let response;
      try {
        const result = await store.create(input, { clientKey: "widget-test" });
        response = Response.json({
          data: {
            id: result.ticket.id,
            status: result.ticket.status,
            created_at: new Date(result.ticket.created_at).toISOString(),
            duplicate: result.duplicate,
          },
        }, { status: result.duplicate ? 200 : 201 });
      } catch (error) {
        response = Response.json({
          error: { code: error.code, message: error.message, field_errors: error.fieldErrors },
        }, { status: error.code === "INVALID_PAYLOAD" ? 400 : 503 });
      }
      return deliver(response, requests.length);
    }));
  });

  afterEach(async () => {
    cleanup();
    connectedPublicKey.set("");
    vi.unstubAllGlobals();
    await fs.rm(directory, { recursive: true, force: true });
  });

  async function openDraft(description = DESCRIPTION) {
    render(<SupportWidget />);
    fireEvent.click(screen.getByRole("button", { name: "Open support" }));
    fireEvent.click(await screen.findByRole("button", { name: /submit a ticket/i }));
    fireEvent.change(screen.getByPlaceholderText("John Doe"), { target: { value: "Ada Lovelace" } });
    fireEvent.change(screen.getByPlaceholderText("john@example.com"), { target: { value: "ada@example.com" } });
    changeDescription(description);
  }

  function changeDescription(value) {
    fireEvent.change(screen.getByPlaceholderText("Please describe your issue in detail..."), { target: { value } });
  }

  function submit() {
    fireEvent.submit(screen.getByPlaceholderText("John Doe").closest("form"));
  }

  async function persisted() {
    return (await fs.readFile(filePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  }

  function loseFirstResponse() {
    deliver = async (response, attempt) => {
      if (attempt === 1) throw new TypeError("response lost after persistence");
      return response;
    };
  }

  it("gives an edited retry a new key and durably stores the edited ticket", async () => {
    loseFirstResponse();
    await openDraft();
    submit();
    await screen.findByText(/Support intake is unreachable/);
    changeDescription(EDITED_DESCRIPTION);
    submit();

    await screen.findByText("Ticket Submitted!");
    const rows = await persisted();
    expect(rows.map((row) => row.description)).toEqual([DESCRIPTION, EDITED_DESCRIPTION]);
    expect(requests[1].idempotency_key).not.toBe(requests[0].idempotency_key);
    const restarted = new FileSupportTicketStore(filePath);
    expect((await restarted.get(rows[1].id)).description).toBe(EDITED_DESCRIPTION);
  });

  it.each([false, true])("keeps the retry key for an unchanged payload (edits restored: %s)", async (restoreEdits) => {
    loseFirstResponse();
    await openDraft();
    submit();
    await screen.findByText(/Support intake is unreachable/);
    if (restoreEdits) {
      changeDescription(EDITED_DESCRIPTION);
      changeDescription(DESCRIPTION);
    }
    submit();

    expect(await screen.findByRole("status")).toHaveTextContent("A matching ticket was already received.");
    expect(screen.getByDisplayValue(DESCRIPTION)).toBeInTheDocument();
    expect(requests[1].idempotency_key).toBe(requests[0].idempotency_key);
    const rows = await persisted();
    expect(rows).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent(rows[0].id);
    changeDescription(EDITED_DESCRIPTION);
    expect(screen.getByRole("status")).toHaveTextContent("An earlier ticket was received.");
  });

  it("keeps edits when an earlier pending submission is accepted", async () => {
    const ready = deferred();
    const release = deferred();
    deliver = async (response, attempt) => {
      if (attempt === 1) { ready.resolve(); await release.promise; }
      return response;
    };
    await openDraft();
    submit();
    await ready.promise;
    changeDescription(EDITED_DESCRIPTION);
    submit();
    expect(requests).toHaveLength(1);
    await act(async () => { release.resolve(); });

    expect(await screen.findByRole("status")).toHaveTextContent("An earlier ticket was received.");
    expect(screen.getByDisplayValue(EDITED_DESCRIPTION)).toBeInTheDocument();
    expect((await persisted()).map((row) => row.description)).toEqual([DESCRIPTION]);
    submit();
    await screen.findByText("Ticket Submitted!");
    expect((await persisted()).map((row) => row.description)).toEqual([DESCRIPTION, EDITED_DESCRIPTION]);
  });

  it("does not attach an earlier validation error to an edited draft", async () => {
    const ready = deferred();
    const release = deferred();
    deliver = async (response) => { ready.resolve(); await release.promise; return response; };
    await openDraft("x".repeat(4001));
    submit();
    await ready.promise;
    changeDescription(DESCRIPTION);
    await act(async () => { release.resolve(); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Submit Ticket" })).toBeEnabled());

    expect(screen.getByDisplayValue(DESCRIPTION)).toBeInTheDocument();
    expect(screen.queryByText(/Description must be at most/)).not.toBeInTheDocument();
    expect(screen.queryByText("ticket fields failed validation")).not.toBeInTheDocument();
    submit();
    await screen.findByText("Ticket Submitted!");
    expect((await persisted()).map((row) => row.description)).toEqual([DESCRIPTION]);
  });

  it("preserves a changed wallet draft until its own ticket is accepted", async () => {
    const walletA = "G".padEnd(56, "A");
    const walletB = "G".padEnd(56, "B");
    connectedPublicKey.set(walletA);
    const ready = deferred();
    const release = deferred();
    deliver = async (response, attempt) => {
      if (attempt === 1) { ready.resolve(); await release.promise; }
      return response;
    };
    await openDraft();
    submit();
    await ready.promise;
    connectedPublicKey.set(walletB);
    await act(async () => { release.resolve(); });
    expect(await screen.findByRole("status")).toHaveTextContent("An earlier ticket was received.");
    expect(screen.getByDisplayValue(DESCRIPTION)).toBeInTheDocument();
    submit();

    await screen.findByText("Ticket Submitted!");
    expect(requests[1].wallet_address).toBe(walletB);
    expect(requests[1].idempotency_key).not.toBe(requests[0].idempotency_key);
    const rows = await persisted();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.wallet_address)).toEqual([walletA, walletB]);
    expect(screen.queryByDisplayValue(DESCRIPTION)).not.toBeInTheDocument();
  });

  it("rejects malformed acceptance receipts and safely retries the unchanged draft", async () => {
    const malformed = [
      [201, { id: { value: "not-a-reference" }, duplicate: false }],
      [201, { id: 7, duplicate: false }],
      [201, { id: "   ", duplicate: false }],
      [201, { status: undefined, duplicate: false }],
      [201, { status: "pending", duplicate: false }],
      [201, { duplicate: undefined }],
      [201, { duplicate: "false" }],
      [202, { duplicate: false }],
      [200, { duplicate: false }],
      [201, { duplicate: true }],
    ];
    await openDraft();
    for (const [status, fields] of malformed) {
      deliver = async (response) => {
        const payload = await response.json();
        return Response.json({ data: { ...payload.data, ...fields } }, { status });
      };
      submit();
      await screen.findByText(/Could not confirm ticket acceptance/);
      expect(screen.getByDisplayValue(DESCRIPTION)).toBeInTheDocument();
      expect(screen.queryByText("Ticket Submitted!")).not.toBeInTheDocument();
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Submit Ticket" })).toBeEnabled();
    }

    deliver = async (response) => response;
    submit();
    expect(await screen.findByRole("status")).toHaveTextContent("A matching ticket was already received.");
    expect(screen.getByDisplayValue(DESCRIPTION)).toBeInTheDocument();
    expect(new Set(requests.map((input) => input.idempotency_key)).size).toBe(1);
    const rows = await persisted();
    expect(rows).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent(rows[0].id);
  });
});
