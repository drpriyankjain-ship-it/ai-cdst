import {useCallback, useRef} from 'react';
import {UIManager, useWindowDimensions, findNodeHandle} from 'react-native';

const useCenterOnFocus = (scrollViewRef, extraOffset = 0) => {
  const {height} = useWindowDimensions();
  const scrollOffsetRef = useRef(0);

  const handleScroll = useCallback((event) => {
    scrollOffsetRef.current = event?.nativeEvent?.contentOffset?.y || 0;
  }, []);

  const handleFocus = useCallback(
    (event) => {
      const target = event?.target;
      const scrollNode = scrollViewRef.current && findNodeHandle(scrollViewRef.current);

      if (!target || !scrollNode) {
        return;
      }

      UIManager.measure(target, (x, y, width, elementHeight, pageX, pageY) => {
        UIManager.measure(
          scrollNode,
          (sx, sy, sw, sh, scrollPageX, scrollPageY) => {
            const targetCenterY =
              pageY - scrollPageY + scrollOffsetRef.current + elementHeight / 2;
            const desiredOffset = Math.max(0, targetCenterY - height / 2 + extraOffset);
            scrollViewRef.current?.scrollTo({y: desiredOffset, animated: true});
          }
        );
      });
    },
    [extraOffset, height, scrollViewRef]
  );

  return {handleFocus, handleScroll};
};

export default useCenterOnFocus;
