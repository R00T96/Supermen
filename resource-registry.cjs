"use strict";

/**
 * resource-registry.cjs — Typed resource dependency manager.
 *
 * Resources are explicit, versioned, lifecycle-tracked.
 * No string matching. No substring guessing.
 *
 * Resource lifecycle: planned → producing → ready → invalidated
 * Subscribers get notified on status transitions.
 */

const { EventEmitter } = require("events");
const { resourceEntry, ts } = require("./schema.cjs");

class ResourceRegistry extends EventEmitter {
  constructor() {
    super();
    this.resources = new Map(); // resource_id → entry
  }

  /**
   * Declare a resource. Called when controller assigns work.
   */
  declare(resourceId, producer, opts = {}) {
    if (this.resources.has(resourceId)) {
      const existing = this.resources.get(resourceId);
      // Allow re-declaration by same producer (idempotent)
      if (existing.producer === producer) return existing;
      // Different producer = conflict
      this.emit("conflict", {
        resource_id: resourceId,
        existing_producer: existing.producer,
        new_producer: producer,
      });
      return null;
    }

    const entry = resourceEntry({
      resource_id: resourceId,
      producer,
      version: opts.version || "v1",
      status: "planned",
      subscribers: opts.subscribers || [],
    });

    this.resources.set(resourceId, entry);
    this.emit("declared", entry);
    return entry;
  }

  /**
   * Transition resource status. Validates legal transitions.
   */
  transition(resourceId, newStatus, meta = {}) {
    const entry = this.resources.get(resourceId);
    if (!entry) return null;

    const legal = {
      planned: ["producing", "invalidated"],
      producing: ["ready", "invalidated"],
      ready: ["invalidated"],
      invalidated: ["planned"], // allow re-plan after invalidation
    };

    if (!legal[entry.status]?.includes(newStatus)) {
      this.emit("illegal_transition", {
        resource_id: resourceId,
        from: entry.status,
        to: newStatus,
      });
      return null;
    }

    const oldStatus = entry.status;
    entry.status = newStatus;
    entry.updated_at = ts();
    if (meta.version) entry.version = meta.version;

    this.emit("transition", {
      resource_id: resourceId,
      from: oldStatus,
      to: newStatus,
      entry: { ...entry },
      meta,
    });

    // Notify subscribers when resource becomes ready
    if (newStatus === "ready") {
      for (const sub of entry.subscribers) {
        this.emit("ready_for", {
          resource_id: resourceId,
          subscriber: sub,
          producer: entry.producer,
          version: entry.version,
        });
      }
    }

    return entry;
  }

  /**
   * Subscribe a session to a resource. Gets notified when ready.
   */
  subscribe(resourceId, sessionId) {
    const entry = this.resources.get(resourceId);
    if (!entry) return false;
    if (!entry.subscribers.includes(sessionId)) {
      entry.subscribers.push(sessionId);
    }
    // If already ready, notify immediately
    if (entry.status === "ready") {
      this.emit("ready_for", {
        resource_id: resourceId,
        subscriber: sessionId,
        producer: entry.producer,
        version: entry.version,
      });
    }
    return true;
  }

  /**
   * Check if all resources in a list are ready.
   */
  allReady(resourceIds) {
    return resourceIds.every((rid) => {
      const entry = this.resources.get(rid);
      return entry && entry.status === "ready";
    });
  }

  /**
   * Get resources blocking a session (subscribed but not ready).
   */
  getBlockers(sessionId) {
    const blockers = [];
    for (const [rid, entry] of this.resources) {
      if (entry.subscribers.includes(sessionId) && entry.status !== "ready") {
        blockers.push({ resource_id: rid, status: entry.status, producer: entry.producer });
      }
    }
    return blockers;
  }

  /**
   * Get all resources produced by a session.
   */
  getProduced(sessionId) {
    const produced = [];
    for (const [rid, entry] of this.resources) {
      if (entry.producer === sessionId) {
        produced.push({ resource_id: rid, status: entry.status });
      }
    }
    return produced;
  }

  /**
   * Snapshot for serialization / SSE.
   */
  snapshot() {
    const result = {};
    for (const [rid, entry] of this.resources) {
      result[rid] = { ...entry };
    }
    return result;
  }

  clear() {
    this.resources.clear();
  }
}

module.exports = { ResourceRegistry };
