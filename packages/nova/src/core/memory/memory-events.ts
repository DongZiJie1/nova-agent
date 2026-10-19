/**
 * 进程内记忆变更事件。
 *
 * 存储层（`FactStore` / `SuggestionStore`）每次成功写文件后广播一次变更，
 * 由外部出口（RPC 模式、将来的前端桥接）订阅并转发。这里只搬“变了”这个事实，
 * 不承载业务语义，也不做合并——去抖属于订阅方（RPC 模式按 100ms 窗口合并）。
 *
 * 两条不变量：
 * - 单个监听器抛错只记录，不影响其它监听器，也不能让写文件的调用方失败。
 * - 退订函数可重复调用，退订后不再收到事件。
 */

export type MemoryChangedReason =
	| "fact_added"
	| "fact_updated"
	| "fact_archived"
	| "suggestion_added"
	| "suggestion_resolved"
	| "store";

export interface MemoryChangedEvent {
	type: "memory_changed";
	reason: MemoryChangedReason;
}

export type MemoryChangedListener = (event: MemoryChangedEvent) => void;

const listeners = new Set<MemoryChangedListener>();

/**
 * 广播一次记忆变更。没有订阅者时直接返回，避免为每次写入构造事件对象。
 */
export function notifyMemoryChanged(reason: MemoryChangedReason): void {
	if (listeners.size === 0) return;
	const event: MemoryChangedEvent = { type: "memory_changed", reason };
	// 复制一份再遍历：监听器内部退订或新增订阅不能影响本轮分发。
	for (const listener of [...listeners]) {
		try {
			listener(event);
		} catch (error) {
			console.error("[memory:events]", error);
		}
	}
}

/**
 * 订阅记忆变更，返回退订函数。
 * 每次调用都是一次独立订阅（同一个函数订阅两次会收到两份），互不影响退订。
 */
export function onMemoryChanged(listener: MemoryChangedListener): () => void {
	const entry: MemoryChangedListener = (event) => listener(event);
	listeners.add(entry);
	let subscribed = true;
	return () => {
		if (!subscribed) return;
		subscribed = false;
		listeners.delete(entry);
	};
}
