"use client";

import React, { useState, useRef } from "react";
import { 
  HelpCircle, 
  X, 
  ChevronRight, 
  MessageSquare, 
  LifeBuoy, 
  ShieldCheck, 
  Wallet, 
  ArrowLeft,
  Send,
  CheckCircle2,
  AlertCircle
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import {
  connectedPublicKey,
} from "@vaultquest/stellar-wallet-connect/src/core/store";

const FAQ_CATEGORIES = [
  {
    id: "wallet",
    title: "Wallet Connection",
    icon: Wallet,
    questions: [
      { q: "How do I connect my Stellar wallet?", a: "Click the 'Connect Wallet' button in the top right and select your preferred provider (Albedo, Freight Freighter, or xBull)." },
      { q: "My wallet won't connect on mobile.", a: "Ensure you're using the built-in browser within your wallet app or a compatible mobile browser like Chrome or Safari." }
    ]
  },
  {
    id: "transactions",
    title: "Transactions",
    icon: MessageSquare,
    questions: [
      { q: "Why is my transaction pending?", a: "Blockchain congestion can occasionally slow down processing. If it takes longer than 5 minutes, check the network status below." },
      { q: "Are there any deposit fees?", a: "VaultQuest doesn't charge deposit fees, but you will need a small amount of XLM for Stellar network gas fees." }
    ]
  },
  {
    id: "security",
    title: "Security & Trust",
    icon: ShieldCheck,
    questions: [
      { q: "Is my capital safe?", a: "All funds are held in audited smart contracts. You can withdraw your principal at any time." },
      { q: "How are winners selected?", a: "We use a transparent, verifiable random function to ensure fair prize distribution." }
    ]
  }
];

function currentWalletHint() {
  return typeof connectedPublicKey?.get === "function"
    ? connectedPublicKey.get() || ""
    : "";
}

export default function SupportWidget() {
  const [isOpen, setIsOpen] = useState(false);
  const [view, setView] = useState("home"); // home, faq-list, faq-detail, ticket, success
  const [selectedCategory, setSelectedCategory] = useState(null);
  const [formData, setFormData] = useState({ name: "", email: "", category: "general", description: "" });
  const [formErrors, setFormErrors] = useState({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [receiptId, setReceiptId] = useState(null);
  const [receiptNotice, setReceiptNotice] = useState(null);
  const retryRef = useRef(null);
  const submittingRef = useRef(false);
  const formRevisionRef = useRef(0);

  const toggleWidget = () => {
    formRevisionRef.current += 1;
    setIsOpen(!isOpen);
    if (!isOpen) {
      setView("home");
      setFormErrors({});
    }
  };

  const showView = (nextView) => {
    formRevisionRef.current += 1;
    setView(nextView);
  };

  const validateForm = () => {
    const errors = {};
    if (!formData.name.trim()) errors.name = "Name is required";
    if (!formData.email.trim()) {
      errors.email = "Email is required";
    } else if (!/\S+@\S+\.\S+/.test(formData.email)) {
      errors.email = "Invalid email format";
    }
    if (!formData.description.trim()) errors.description = "Description is required";
    return errors;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (submittingRef.current) return;
    const errors = validateForm();
    if (Object.keys(errors).length > 0) {
      setFormErrors(errors);
      return;
    }

    const walletHint = currentWalletHint();
    const ticketPayload = {
      name: formData.name,
      email: formData.email,
      category: formData.category,
      description: formData.description,
      wallet_address: walletHint || undefined,
    };
    const payloadIdentity = JSON.stringify(ticketPayload);
    const revision = formRevisionRef.current;
    const ownsDraft = () =>
      revision === formRevisionRef.current && walletHint === currentWalletHint();

    submittingRef.current = true;
    setIsSubmitting(true);
    setSubmitError(null);
    setFormErrors({});
    setReceiptNotice((notice) => notice ? "earlier" : null);

    try {
      // An uncertain retry keeps its key only for the same submitted content.
      // Comparing at submit time also preserves the key after edits are undone.
      if (retryRef.current?.payloadIdentity !== payloadIdentity) {
        retryRef.current = {
          payloadIdentity,
          key: typeof crypto !== "undefined" && crypto.randomUUID
            ? crypto.randomUUID()
            : `ticket-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        };
      }

      const res = await fetch("/api/support/tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...ticketPayload,
          idempotency_key: retryRef.current.key,
        }),
        signal: AbortSignal.timeout(10000),
      });

      let payload = null;
      try {
        payload = await res.json();
      } catch {
        payload = null;
      }

      if (!res.ok) {
        if (!ownsDraft()) return;
        if (res.status === 409 && payload?.error?.code === "IDEMPOTENCY_CONFLICT") {
          // A confirmed rejection can use a new key on the next explicit submit.
          retryRef.current = null;
        }
        const message =
          payload?.error?.message ||
          (res.status === 429
            ? "Too many tickets submitted. Please wait and try again."
            : "Could not submit your ticket. Your draft was kept — try again.");
        const fieldErrors = payload?.error?.field_errors;
        if (fieldErrors && typeof fieldErrors === "object") {
          setFormErrors(fieldErrors);
        }
        setSubmitError(message);
        return;
      }

      const ticket = payload?.data;
      const id = ticket?.id;
      // A successful HTTP response alone does not confirm durable acceptance.
      // Keep uncertain replies retryable, with the original draft and key.
      const accepted = typeof id === "string" && id.trim().length > 0 &&
        ticket.status === "accepted" && (
          (res.status === 201 && ticket.duplicate === false) ||
          (res.status === 200 && ticket.duplicate === true)
        );
      if (!accepted) {
        if (ownsDraft()) {
          setSubmitError("Could not confirm ticket acceptance. Your draft was kept — try again.");
        }
        return;
      }

      setReceiptId(id);
      if (!ownsDraft()) {
        setReceiptNotice("earlier");
        return;
      }
      // The intake also deduplicates similar content without comparing every
      // field. A matching receipt cannot confirm that all current edits saved.
      if (payload.data.duplicate) {
        setReceiptNotice("duplicate");
        return;
      }
      setReceiptNotice(null);
      setView("success");
      setFormData({ name: "", email: "", category: "general", description: "" });
      retryRef.current = null;
    } catch {
      if (ownsDraft()) {
        setSubmitError("Support intake is unreachable. Your draft was kept — try again.");
      }
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    if (formData[name] !== value) {
      formRevisionRef.current += 1;
      setReceiptNotice((notice) => notice ? "earlier" : null);
    }
    setFormData(prev => ({ ...prev, [name]: value }));
    if (formErrors[name]) {
      setFormErrors(prev => ({ ...prev, [name]: null }));
    }
  };

  const containerVariants = {
    hidden: { opacity: 0, y: 20, scale: 0.95 },
    visible: { opacity: 1, y: 0, scale: 1 },
    exit: { opacity: 0, y: 20, scale: 0.95 }
  };

  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col items-end">
      <AnimatePresence>
        {isOpen && (
          <motion.div
            variants={containerVariants}
            initial="hidden"
            animate="visible"
            exit="exit"
            className="mb-4 w-[350px] overflow-hidden rounded-2xl border border-vault-border bg-vault-surface/80 shadow-glass backdrop-blur-xl sm:w-[400px]"
          >
            {/* Header */}
            <div className="flex items-center justify-between border-b border-vault-border bg-vault-accent/5 p-4">
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-vault-accent/20 text-vault-accent">
                  <LifeBuoy size={18} />
                </div>
                <h3 className="font-semibold text-vault-text">Live Support</h3>
              </div>
              <button 
                onClick={toggleWidget}
                className="rounded-full p-1 text-vault-muted hover:bg-vault-surface hover:text-vault-text transition-colors"
              >
                <X size={20} />
              </button>
            </div>

            {/* Content Area */}
            <div className="max-h-[500px] overflow-y-auto p-4">
              {receiptNotice && receiptId && (
                <div role="status" className="mb-4 space-y-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-vault-text">
                  <p>{receiptNotice === "earlier"
                    ? "An earlier ticket was received."
                    : "A matching ticket was already received."}</p>
                  <p className="font-mono text-xs">Reference: {receiptId}</p>
                  <p className="text-xs text-vault-muted">Your draft has been kept. Review it before resubmitting.</p>
                </div>
              )}
              {view === "home" && (
                <div className="space-y-4">
                  <div className="rounded-xl bg-vault-accent/10 p-4 border border-vault-accent/20">
                    <p className="text-sm text-vault-text">
                      Hi there! 👋 Need help with your vaults or rewards? Check our FAQs or send us a message.
                    </p>
                  </div>

                  <div className="grid gap-3">
                    <button 
                      onClick={() => showView("faq-list")}
                      className="flex items-center justify-between rounded-xl border border-vault-border bg-vault-surface/50 p-4 text-left transition-all hover:border-vault-accent/50 hover:bg-vault-accent/5"
                    >
                      <div className="flex items-center gap-3">
                        <HelpCircle className="text-vault-accent" size={20} />
                        <div>
                          <p className="font-medium text-vault-text">Browse FAQs</p>
                          <p className="text-xs text-vault-muted">Common questions & answers</p>
                        </div>
                      </div>
                      <ChevronRight size={18} className="text-vault-muted" />
                    </button>

                    <button 
                      onClick={() => showView("ticket")}
                      className="flex items-center justify-between rounded-xl border border-vault-border bg-vault-surface/50 p-4 text-left transition-all hover:border-vault-accent/50 hover:bg-vault-accent/5"
                    >
                      <div className="flex items-center gap-3">
                        <MessageSquare className="text-vault-accent" size={20} />
                        <div>
                          <p className="font-medium text-vault-text">Submit a Ticket</p>
                          <p className="text-xs text-vault-muted">Our team will get back to you</p>
                        </div>
                      </div>
                      <ChevronRight size={18} className="text-vault-muted" />
                    </button>
                  </div>

                  <div className="pt-2">
                    <div className="flex items-center justify-between px-2 text-[10px] uppercase tracking-wider text-vault-muted font-bold">
                      <span>System Status</span>
                      <span className="flex items-center gap-1 text-emerald-500">
                        <div className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                        Operational
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {view === "faq-list" && (
                <div className="space-y-3">
                  <button 
                    onClick={() => showView("home")}
                    className="flex items-center gap-2 text-sm text-vault-muted hover:text-vault-text transition-colors mb-4"
                  >
                    <ArrowLeft size={16} /> Back to home
                  </button>
                  <h4 className="text-lg font-semibold text-vault-text mb-2">How can we help?</h4>
                  <div className="grid gap-3">
                    {FAQ_CATEGORIES.map((cat) => (
                      <button
                        key={cat.id}
                        onClick={() => {
                          setSelectedCategory(cat);
                          showView("faq-detail");
                        }}
                        className="flex items-center gap-3 rounded-xl border border-vault-border bg-vault-surface/50 p-4 text-left transition-all hover:border-vault-accent/50 hover:bg-vault-accent/5"
                      >
                        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-vault-surface text-vault-accent border border-vault-border">
                          <cat.icon size={20} />
                        </div>
                        <div className="flex-1">
                          <p className="font-medium text-vault-text">{cat.title}</p>
                          <p className="text-xs text-vault-muted">{cat.questions.length} articles</p>
                        </div>
                        <ChevronRight size={18} className="text-vault-muted" />
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {view === "faq-detail" && selectedCategory && (
                <div className="space-y-4">
                  <button 
                    onClick={() => showView("faq-list")}
                    className="flex items-center gap-2 text-sm text-vault-muted hover:text-vault-text transition-colors mb-4"
                  >
                    <ArrowLeft size={16} /> All categories
                  </button>
                  <div className="flex items-center gap-3 mb-6">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-vault-accent/10 text-vault-accent">
                      <selectedCategory.icon size={22} />
                    </div>
                    <h4 className="text-lg font-semibold text-vault-text">{selectedCategory.title}</h4>
                  </div>
                  <div className="space-y-6">
                    {selectedCategory.questions.map((item, idx) => (
                      <div key={idx} className="space-y-2">
                        <p className="font-medium text-vault-text">{item.q}</p>
                        <p className="text-sm text-vault-muted leading-relaxed">{item.a}</p>
                        {idx !== selectedCategory.questions.length - 1 && <div className="border-b border-vault-border pt-4" />}
                      </div>
                    ))}
                  </div>
                  <div className="mt-8 rounded-xl bg-vault-surface p-4 text-center border border-vault-border">
                    <p className="text-sm text-vault-muted mb-3">Didn&apos;t find what you need?</p>
                    <button 
                      onClick={() => showView("ticket")}
                      className="vq-btn-primary w-full py-2"
                    >
                      Contact Support
                    </button>
                  </div>
                </div>
              )}

              {view === "ticket" && (
                <div className="space-y-4">
                  <button 
                    onClick={() => showView("home")}
                    className="flex items-center gap-2 text-sm text-vault-muted hover:text-vault-text transition-colors mb-4"
                  >
                    <ArrowLeft size={16} /> Back
                  </button>
                  <h4 className="text-lg font-semibold text-vault-text">Submit a support ticket</h4>
                  <form onSubmit={handleSubmit} className="space-y-4">
                    <div className="space-y-1">
                      <label htmlFor="support-name" className="text-xs font-medium text-vault-muted px-1">Full Name</label>
                      <input
                        id="support-name"
                        type="text"
                        name="name"
                        value={formData.name}
                        onChange={handleInputChange}
                        placeholder="John Doe"
                        className={`w-full rounded-xl border ${formErrors.name ? 'border-red-500/50' : 'border-vault-border'} bg-vault-surface/50 p-3 text-sm text-vault-text focus:border-vault-accent focus:outline-none`}
                      />
                      {formErrors.name && <p className="text-[10px] text-red-400 mt-1 flex items-center gap-1"><AlertCircle size={10} /> {formErrors.name}</p>}
                    </div>

                    <div className="space-y-1">
                      <label htmlFor="support-email" className="text-xs font-medium text-vault-muted px-1">Email Address</label>
                      <input
                        id="support-email"
                        type="email"
                        name="email"
                        value={formData.email}
                        onChange={handleInputChange}
                        placeholder="john@example.com"
                        className={`w-full rounded-xl border ${formErrors.email ? 'border-red-500/50' : 'border-vault-border'} bg-vault-surface/50 p-3 text-sm text-vault-text focus:border-vault-accent focus:outline-none`}
                      />
                      {formErrors.email && <p className="text-[10px] text-red-400 mt-1 flex items-center gap-1"><AlertCircle size={10} /> {formErrors.email}</p>}
                    </div>

                    <div className="space-y-1">
                      <label htmlFor="support-category" className="text-xs font-medium text-vault-muted px-1">Category</label>
                      <select
                        id="support-category"
                        name="category"
                        value={formData.category}
                        onChange={handleInputChange}
                        className="w-full rounded-xl border border-vault-border bg-vault-surface p-3 text-sm text-vault-text focus:border-vault-accent focus:outline-none appearance-none"
                      >
                        <option value="general">General Inquiry</option>
                        <option value="wallet">Wallet Connection</option>
                        <option value="transaction">Transaction Issue</option>
                        <option value="bug">Report a Bug</option>
                      </select>
                    </div>

                    <div className="space-y-1">
                      <label htmlFor="support-description" className="text-xs font-medium text-vault-muted px-1">Description</label>
                      <textarea
                        id="support-description"
                        name="description"
                        rows={4}
                        value={formData.description}
                        onChange={handleInputChange}
                        placeholder="Please describe your issue in detail..."
                        className={`w-full rounded-xl border ${formErrors.description ? 'border-red-500/50' : 'border-vault-border'} bg-vault-surface/50 p-3 text-sm text-vault-text focus:border-vault-accent focus:outline-none resize-none`}
                      />
                      {formErrors.description && <p className="text-[10px] text-red-400 mt-1 flex items-center gap-1"><AlertCircle size={10} /> {formErrors.description}</p>}
                    </div>

                    {submitError && (
                      <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300 flex items-start gap-2">
                        <AlertCircle size={16} className="mt-0.5 shrink-0" />
                        <div className="space-y-1">
                          <p>{submitError}</p>
                          <p className="text-xs text-red-200/80">Your draft is still here — fix the issue and resubmit.</p>
                        </div>
                      </div>
                    )}

                    <button
                      type="submit"
                      disabled={isSubmitting}
                      className="vq-btn-primary w-full py-3 flex items-center justify-center gap-2 group"
                    >
                      {isSubmitting ? (
                        <div className="h-5 w-5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                      ) : (
                        <>
                          Submit Ticket
                          <Send size={16} className="transition-transform group-hover:translate-x-1 group-hover:-translate-y-1" />
                        </>
                      )}
                    </button>
                  </form>
                </div>
              )}

              {view === "success" && (
                <div className="flex flex-col items-center justify-center py-10 text-center space-y-4">
                  <div className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-500">
                    <CheckCircle2 size={32} />
                  </div>
                  <div>
                    <h4 className="text-xl font-bold text-vault-text">Ticket Submitted!</h4>
                    <p className="text-sm text-vault-muted mt-2">
                      We&apos;ve received your request. Our support team will respond via email within 24 hours.
                    </p>
                    {receiptId && (
                      <p className="mt-3 rounded-lg border border-vault-border bg-vault-surface/60 px-3 py-2 font-mono text-xs text-vault-text">
                        Reference: <span className="text-vault-accent">{receiptId}</span>
                      </p>
                    )}
                  </div>
                  <button 
                    onClick={() => {
                      setReceiptId(null);
                      setSubmitError(null);
                      showView("home");
                    }}
                    className="vq-btn-ghost px-6 py-2 mt-4"
                  >
                    Back to Home
                  </button>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Floating Trigger Button */}
      <motion.button
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        onClick={toggleWidget}
        className={`flex h-14 w-14 items-center justify-center rounded-full shadow-glow transition-all duration-300 ${
          isOpen ? 'bg-vault-surface text-vault-text rotate-90' : 'bg-vault-accent text-white'
        }`}
        aria-label="Open support"
      >
        {isOpen ? <X size={28} /> : <HelpCircle size={28} />}
      </motion.button>
    </div>
  );
}
