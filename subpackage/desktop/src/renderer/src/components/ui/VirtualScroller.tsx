/**
 * 虚拟滚动组件
 * 只渲染可见区域的元素，提升长列表性能
 */
import { useEffect, useRef, useState, useCallback, type ReactNode } from "react";

interface VirtualScrollerProps<T> {
  items: T[];
  itemHeight: number | ((item: T, index: number) => number);
  renderItem: (item: T, index: number) => ReactNode;
  overscan?: number; // 上下额外渲染的项目数，避免滚动时白屏
  className?: string;
  onScroll?: (scrollTop: number) => void;
  containerRef?: React.RefObject<HTMLDivElement>;
}

export function VirtualScroller<T>({
  items,
  itemHeight,
  renderItem,
  overscan = 3,
  className = "",
  onScroll,
  containerRef: externalRef,
}: VirtualScrollerProps<T>) {
  const internalRef = useRef<HTMLDivElement>(null);
  const containerRef = externalRef || internalRef;
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);

  // 计算单个项目的高度
  const getItemHeight = useCallback(
    (index: number): number => {
      if (typeof itemHeight === "function") {
        return itemHeight(items[index], index);
      }
      return itemHeight;
    },
    [itemHeight, items]
  );

  // 计算所有项目的总高度
  const totalHeight = items.reduce((sum, _, index) => {
    return sum + getItemHeight(index);
  }, 0);

  // 计算可见范围
  const getVisibleRange = useCallback(() => {
    if (containerHeight === 0) {
      return { start: 0, end: Math.min(20, items.length) };
    }

    let currentTop = 0;
    let startIndex = 0;
    let endIndex = items.length;

    // 找到第一个可见项
    for (let i = 0; i < items.length; i++) {
      const height = getItemHeight(i);
      if (currentTop + height > scrollTop) {
        startIndex = Math.max(0, i - overscan);
        break;
      }
      currentTop += height;
    }

    // 找到最后一个可见项
    currentTop = 0;
    for (let i = 0; i < items.length; i++) {
      const height = getItemHeight(i);
      if (currentTop > scrollTop + containerHeight) {
        endIndex = Math.min(items.length, i + overscan);
        break;
      }
      currentTop += height;
    }

    return { start: startIndex, end: endIndex };
  }, [scrollTop, containerHeight, items.length, getItemHeight, overscan]);

  const { start, end } = getVisibleRange();

  // 计算偏移量
  const getOffsetTop = useCallback(
    (index: number): number => {
      let offset = 0;
      for (let i = 0; i < index; i++) {
        offset += getItemHeight(i);
      }
      return offset;
    },
    [getItemHeight]
  );

  const offsetTop = getOffsetTop(start);

  // 监听滚动
  const handleScroll = useCallback(() => {
    if (!containerRef.current) return;
    const newScrollTop = containerRef.current.scrollTop;
    setScrollTop(newScrollTop);
    onScroll?.(newScrollTop);
  }, [containerRef, onScroll]);

  // 监听容器大小变化
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateHeight = () => {
      setContainerHeight(container.clientHeight);
    };

    const resizeObserver = new ResizeObserver(updateHeight);
    resizeObserver.observe(container);
    updateHeight();

    return () => resizeObserver.disconnect();
  }, [containerRef]);

  // 滚动事件监听
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [containerRef, handleScroll]);

  return (
    <div
      ref={containerRef}
      className={`virtual-scroller ${className}`}
      style={{ overflowY: "auto", height: "100%" }}
    >
      <div style={{ height: totalHeight, position: "relative" }}>
        <div style={{ transform: `translateY(${offsetTop}px)` }}>
          {items.slice(start, end).map((item, relativeIndex) => {
            const absoluteIndex = start + relativeIndex;
            return (
              <div key={absoluteIndex} data-index={absoluteIndex}>
                {renderItem(item, absoluteIndex)}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
