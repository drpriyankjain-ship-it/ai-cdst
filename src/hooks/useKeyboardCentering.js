import {useCallback, useEffect, useRef, useState} from 'react';
import {Keyboard, Dimensions, UIManager, findNodeHandle} from 'react-native';

const useKeyboardCentering = (scrollRef) => {
  const keyboardHeightRef = useRef(0);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const scrollYRef = useRef(0);
  const lastFocusedRef = useRef(null);

  useEffect(() => {
    const showSub = Keyboard.addListener('keyboardDidShow', (event) => {
      keyboardHeightRef.current = event?.endCoordinates?.height || 0;
      setKeyboardHeight(keyboardHeightRef.current);
      if (lastFocusedRef.current) {
        setTimeout(() => {
          scrollToCenter(lastFocusedRef.current);
        }, 80);
      }
    });
    const hideSub = Keyboard.addListener('keyboardDidHide', () => {
      keyboardHeightRef.current = 0;
      setKeyboardHeight(0);
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [scrollToCenter]);

  const onScroll = useCallback((event) => {
    scrollYRef.current = event?.nativeEvent?.contentOffset?.y || 0;
  }, []);

  const scrollToOffset = useCallback(
    (offset) => {
      if (!scrollRef?.current) return;
      if (typeof scrollRef.current.scrollTo === 'function') {
        scrollRef.current.scrollTo({y: offset, animated: true});
        return;
      }
      if (typeof scrollRef.current.scrollToOffset === 'function') {
        scrollRef.current.scrollToOffset({offset, animated: true});
      }
    },
    [scrollRef]
  );

  const scrollToCenter = useCallback(
    (target) => {
      const node =
        typeof target === 'number'
          ? target
          : findNodeHandle(target?.current || target);
      if (!node || !scrollRef?.current) return;

      UIManager.measureInWindow(node, (x, y, width, height) => {
        const screenHeight = Dimensions.get('window').height;
        const visibleHeight = screenHeight - keyboardHeightRef.current;
        if (!visibleHeight || visibleHeight <= 0) return;

        const inputCenterY = y + height / 2;
        const targetCenterY = visibleHeight / 2;
        const delta = inputCenterY - targetCenterY;
        if (Math.abs(delta) < 4) return;

        const nextOffset = Math.max(scrollYRef.current + delta - 8, 0);
        scrollToOffset(nextOffset);
      });
    },
    [scrollRef, scrollToOffset]
  );

  const handleFocus = useCallback(
    (event) => {
      const target = event?.target;
      if (!target) return;
      lastFocusedRef.current = target;
      setTimeout(() => {
        scrollToCenter(target);
      }, 80);
    },
    [scrollToCenter]
  );

  return {onScroll, handleFocus, scrollToCenter, keyboardHeight};
};

export default useKeyboardCentering;
