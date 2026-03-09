"use strict";

/**
 * schema.cjs — Canonical event envelope + typed message schemas.
 *
 * Every event in the system flows through one envelope.
 * Every control message has explicit structure.
 * No stringly-typed anything.
 */

const crypto = require("crypto");

function uuid() {
  return crypto.randomUUID();
}

function ts() {
  return new Date().toISOString();
}

// ─── Event Envelope ─────────────────────────────────────────────────────────
// One shape for everything. Gives causality, replay, graphability.

function envelope(fields) {
  return {
    event_id: uuid(),
    session_id: fields.session_id || null,
    run_id: fields.run_id || null,
    goal_id: fields.goal_id || null,
    type: fields.type,
    ts: ts(),
    seq: fields.seq || 0,
    payload: fields.payload || {},
    produces: fields.produces || [],
    needs: fields.needs || [],
    files: fields.files || [],
    decision_id: fields.decision_id || null,
    parent_event_id: fields.parent_event_id || null,
  };
}

// ─── Child → Controller Event Types ─────────────────────────────────────────

const CHILD_EVENT_TYPES = new Set([
  "progress",
  "file_written",
  "intent_write",      // request write lock before mutation
  "blocked",
  "done",
  "error",
  "ack",               // acknowledge control message
  "decision_detected", // child surfaced a decision
  "raw",               // unparseable line, wrapped
]);

// ─── Controller → Child Message Types ───────────────────────────────────────

const CONTROL_MSG_TYPES = new Set([
  "redirect",
  "context",
  "unblocked",
  "conflict",
  "lock_granted",
  "lock_denied",
  "signal",           // generic signal (pause, resume, abort)
]);

// ─── Control Message with ACK support ───────────────────────────────────────

function controlMessage(fields) {
  return {
    msg_id: uuid(),
    type: fields.type,
    ts: ts(),
    requires_ack: fields.requires_ack !== undefined ? fields.requires_ack : false,
    ttl_ms: fields.ttl_ms || 30000,
    payload: fields.payload || {},
  };
}

// ─── Resource ID ────────────────────────────────────────────────────────────
// Explicit, structured, no fuzzy matching.
// Format: "<domain>:<artifact>:<version>"
// Examples: "db:schema:v1", "api:routes:v1", "ui:components:v1"

function resourceId(domain, artifact, version) {
  return `${domain}:${artifact}:${version || "v1"}`;
}

function parseResourceId(rid) {
  const parts = rid.split(":");
  return {
    domain: parts[0] || null,
    artifact: parts[1] || null,
    version: parts[2] || null,
  };
}

// ─── Resource Registry Entry ────────────────────────────────────────────────

const RESOURCE_STATUSES = ["planned", "producing", "ready", "invalidated"];

function resourceEntry(fields) {
  return {
    resource_id: fields.resource_id,
    producer: fields.producer || null,
    version: fields.version || "v1",
    status: fields.status || "planned",
    subscribers: fields.subscribers || [],
    created_at: ts(),
    updated_at: ts(),
  };
}

// ─── Decision Event ─────────────────────────────────────────────────────────
// Bridge to the decision intelligence pipeline.

function decisionEvent(fields) {
  return envelope({
    ...fields,
    type: "decision_detected",
    payload: {
      decision_id: fields.decision_id || uuid(),
      context: fields.context || "",
      options: fields.options || [],
      chosen: fields.chosen || null,
      reasoning_summary: fields.reasoning_summary || "",
      confidence: fields.confidence || 0,
      constraints: fields.constraints || [],
      domain: fields.domain || "swarm",
      ...fields.payload,
    },
  });
}

// ─── Outcome Event ──────────────────────────────────────────────────────────
// Delayed verification of decision quality.

function outcomeEvent(fields) {
  return envelope({
    ...fields,
    type: "outcome",
    payload: {
      decision_id: fields.decision_id,
      outcome: fields.outcome || "unknown", // success | failure | partial | rework
      metrics: fields.metrics || {},
      time_saved_ms: fields.time_saved_ms || null,
      rework_caused: fields.rework_caused || false,
      notes: fields.notes || "",
      ...fields.payload,
    },
  });
}

module.exports = {
  uuid,
  ts,
  envelope,
  controlMessage,
  resourceId,
  parseResourceId,
  resourceEntry,
  decisionEvent,
  outcomeEvent,
  CHILD_EVENT_TYPES,
  CONTROL_MSG_TYPES,
  RESOURCE_STATUSES,
};
