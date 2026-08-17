import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { postHostMessage, subscribeHost } from '../bridge/hostBridge';
import type {
  AppState,
  CharacterProfile,
  HostMessage,
  Reminder,
  ReminderPriority,
} from '../types';
import styles from './Pet.module.scss';

type PetAction = 'idle' | 'walkLeft' | 'walkRight' | 'wave' | 'hop' | 'sleepy' | 'petted';
type InteractionView = 'closed' | 'choices' | 'actions' | 'feedback';

interface DragGesture {
  pointerId: number;
  startX: number;
  startY: number;
  dragging: boolean;
}

/** Fallback shown before the first native state snapshot arrives. */
const builtInCharacter: CharacterProfile = {
  id: 'builtin',
  name: '经典小鼠',
  imageUrl: '/assets/milo-sprite.png',
  layout: 'sheet',
  builtIn: true,
};

const emptyState: AppState = {
  reminders: [],
  now: Date.now(),
  petName: '可爱依依',
  soundEnabled: true,
  speechEnabled: false,
  autoHideEnabled: true,
  autoHideMinutes: 10,
  characters: [builtInCharacter],
  activeCharacterId: 'builtin',
  workspaceTheme: 'warm',
  workspaceTextSize: 'comfortable',
  openLastView: true,
  lastDashboardView: 'today',
  lastToolCategory: '',
};

const priorityClassNames: Record<ReminderPriority, string> = {
  normal: styles.priorityNormal,
  important: styles.priorityImportant,
  urgent: styles.priorityUrgent,
};

const actionMessages: Record<PetAction, string> = {
  idle: '我在这里陪着你。',
  walkLeft: '左边有什么好玩的呢？',
  walkRight: '出发，散一小会儿步！',
  wave: '看到你啦，挥挥手！',
  hop: '跳一下，打起精神！',
  sleepy: '先眯一小会儿，记得也要休息。',
  petted: '嘿嘿，谢谢你摸摸我，脸都红啦。',
};

function formatShortTime(timestamp: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp);
}

function roundedSquare(
  context: CanvasRenderingContext2D,
  inset: number,
  size: number,
  radius: number,
) {
  const right = inset + size;
  const bottom = inset + size;
  context.beginPath();
  context.moveTo(inset + radius, inset);
  context.arcTo(right, inset, right, bottom, radius);
  context.arcTo(right, bottom, inset, bottom, radius);
  context.arcTo(inset, bottom, inset, inset, radius);
  context.arcTo(inset, inset, right, inset, radius);
  context.closePath();
}

/** Renders the active wardrobe asset into a shell-friendly square PNG. */
function renderCharacterIcon(character: CharacterProfile) {
  return new Promise<string>((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 256;
      const context = canvas.getContext('2d');
      if (!context) {
        reject(new Error('当前环境无法生成小助手图标。'));
        return;
      }

      roundedSquare(context, 2, 252, 54);
      context.fillStyle = '#168b85';
      context.fill();
      roundedSquare(context, 13, 230, 45);
      context.fillStyle = '#fff7eb';
      context.fill();

      const sourceWidth = character.layout === 'sheet'
        ? image.naturalWidth / 4
        : image.naturalWidth;
      const sourceHeight = character.layout === 'sheet'
        ? image.naturalHeight / 2
        : image.naturalHeight;
      const scale = Math.min(202 / sourceWidth, 202 / sourceHeight);
      const width = sourceWidth * scale;
      const height = sourceHeight * scale;
      context.drawImage(
        image,
        0,
        0,
        sourceWidth,
        sourceHeight,
        (256 - width) / 2,
        (256 - height) / 2,
        width,
        height,
      );
      resolve(canvas.toDataURL('image/png'));
    };
    image.onerror = () => reject(new Error('无法读取当前小助手图片。'));
    image.src = character.imageUrl;
  });
}

export function Pet() {
  // The development-only demo makes the full-screen presentation reproducible
  // without waiting for a real native reminder.
  const isPresentationDemo =
    import.meta.env.DEV &&
    new URLSearchParams(window.location.search).get('demo') === 'reminder';
  const demoReminder: Reminder | null = isPresentationDemo
    ? {
        id: -1,
        title: '整理并提交今晚的 C++11 小助手学习笔记',
        dueAt: Date.now(),
        completed: false,
        notified: true,
        repeatRule: 'none',
        priority: 'urgent',
      }
    : null;
  const [state, setState] = useState<AppState>(emptyState);
  const [action, setAction] = useState<PetAction>(isPresentationDemo ? 'hop' : 'idle');
  const [actionCycle, setActionCycle] = useState(0);
  const [activeReminder, setActiveReminder] = useState<Reminder | null>(demoReminder);
  const activeReminderRef = useRef<Reminder | null>(demoReminder);
  const [isPresenting, setIsPresenting] = useState(isPresentationDemo);
  const [message, setMessage] = useState('嗨，我是可爱依依！');
  const [hour, setHour] = useState(new Date().getHours());
  const [celebrating, setCelebrating] = useState(false);
  const [interactionView, setInteractionView] = useState<InteractionView>('closed');
  const [isDragging, setIsDragging] = useState(false);
  const celebrationTimer = useRef<number>();
  const interactionTimer = useRef<number>();
  const dragGesture = useRef<DragGesture | null>(null);
  const activeCharacter = state.characters?.find(
    (character) => character.id === state.activeCharacterId,
  ) ?? state.characters?.[0] ?? builtInCharacter;

  /** Restarts the short completion-confetti animation. */
  const triggerCelebration = () => {
    setCelebrating(true);
    window.clearTimeout(celebrationTimer.current);
    celebrationTimer.current = window.setTimeout(() => setCelebrating(false), 1900);
  };

  const nextReminder = useMemo(
    () => state.reminders.find((reminder) => !reminder.completed) ?? null,
    [state.reminders],
  );

  useEffect(() => {
    // One subscription owns all cross-window state and animation commands.
    const unsubscribe = subscribeHost((hostMessage: HostMessage) => {
      if (hostMessage.type === 'state.sync') {
        const nextState = hostMessage.payload as AppState;
        setState(nextState);
        if (!activeReminderRef.current) setMessage(`嗨，我是${nextState.petName}！`);
      }
      if (hostMessage.type === 'reminder.triggered') {
        const reminder = hostMessage.payload as Reminder;
        activeReminderRef.current = reminder;
        setActiveReminder(reminder);
        setIsPresenting(true);
        setMessage('到时间啦！');
        setAction('hop');
        setInteractionView('closed');
      }
      if (hostMessage.type === 'reminder.dismissed') {
        activeReminderRef.current = null;
        setActiveReminder(null);
        setIsPresenting(false);
        setMessage('好，晚点再叫你。');
        setAction('wave');
      }
      if (hostMessage.type === 'presentation.ended') {
        setIsPresenting(false);
        setMessage('我先回去啦，别忘了这件事哦。');
        setAction('idle');
      }
      if (hostMessage.type === 'pet.action') {
        const requested = (hostMessage.payload as { action?: PetAction })?.action;
        if (requested) {
          setAction(requested);
          setActionCycle((cycle) => cycle + 1);
          setMessage(actionMessages[requested]);
        }
      }
      if (hostMessage.type === 'reminder.completed') {
        triggerCelebration();
        setMessage('完成啦，真棒！');
        setAction('wave');
      }
      if (hostMessage.type === 'app.error') {
        setMessage((hostMessage.payload as { message: string }).message);
        setInteractionView('feedback');
      }
    });

    postHostMessage('app.ready');
    return () => {
      unsubscribe();
      window.clearTimeout(celebrationTimer.current);
      window.clearTimeout(interactionTimer.current);
    };
  }, []);

  useEffect(() => {
    window.clearTimeout(interactionTimer.current);
    if (interactionView === 'closed') return;
    interactionTimer.current = window.setTimeout(
      () => setInteractionView('closed'),
      interactionView === 'feedback' ? 2_600 : 8_000,
    );
    return () => window.clearTimeout(interactionTimer.current);
  }, [interactionView]);

  useEffect(() => {
    setInteractionView('closed');
  }, [activeCharacter.id]);

  useEffect(() => {
    const timer = window.setInterval(() => setHour(new Date().getHours()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    renderCharacterIcon(activeCharacter).then((dataUrl) => {
      if (!cancelled) {
        postHostMessage('character.icon.update', {
          id: activeCharacter.id,
          dataUrl,
        });
      }
    }).catch(() => {
      // The packaged application keeps its embedded icon when rendering fails.
    });
    return () => { cancelled = true; };
  }, [activeCharacter.id, activeCharacter.imageUrl, activeCharacter.layout]);

  useEffect(() => {
    // Autonomous actions are suppressed while a reminder owns the character.
    if (activeReminder) return;
    const timer = window.setInterval(() => {
      const hour = new Date().getHours();
      if (hour >= 23 || hour < 7) {
        setAction('sleepy');
        setMessage('夜深了，早点休息呀。');
        return;
      }
      const choices: PetAction[] = ['idle', 'idle', 'wave', 'walkLeft', 'walkRight'];
      const nextAction = choices[Math.floor(Math.random() * choices.length)];
      setAction(nextAction);
      if (nextAction === 'wave') setMessage('今天也要加油！');
    }, 9_000);
    return () => window.clearInterval(timer);
  }, [activeReminder]);

  useEffect(() => {
    if (action === 'idle' || action === 'sleepy' || activeReminder) return;
    const timer = window.setTimeout(() => setAction('idle'), 2_200);
    return () => window.clearTimeout(timer);
  }, [action, actionCycle, activeReminder]);

  const completeReminder = () => {
    if (!activeReminder) return;
    postHostMessage('reminder.complete', { id: activeReminder.id });
    triggerCelebration();
    activeReminderRef.current = null;
    setActiveReminder(null);
    setIsPresenting(false);
    setMessage('完成啦，真棒！');
    setAction('wave');
  };

  const snoozeReminder = () => {
    if (!activeReminder) return;
    postHostMessage('reminder.snooze', { id: activeReminder.id, minutes: 5 });
    setIsPresenting(false);
  };

  const toggleInteractionMenu = () => {
    if (isPresenting || activeReminder) return;
    setInteractionView((current) => current === 'closed' ? 'choices' : 'closed');
  };

  const requestPetAction = (requested: PetAction) => {
    setMessage(actionMessages[requested]);
    setInteractionView('feedback');
    postHostMessage('pet.action', { action: requested });
  };

  const openDashboard = () => {
    setInteractionView('closed');
    postHostMessage('window.openDashboard');
  };

  const beginCharacterPress = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || isPresenting) return;
    dragGesture.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const continueCharacterPress = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = dragGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (gesture.dragging) {
      postHostMessage('window.drag.move');
      return;
    }
    if (Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) < 6) return;
    gesture.dragging = true;
    setInteractionView('closed');
    setIsDragging(true);
    postHostMessage('window.drag.start');
  };

  const endCharacterPress = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = dragGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragGesture.current = null;
    if (gesture.dragging) {
      postHostMessage('window.drag.end');
      setIsDragging(false);
    } else {
      toggleInteractionMenu();
    }
  };

  const cancelCharacterPress = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragGesture.current?.pointerId !== event.pointerId) return;
    if (dragGesture.current.dragging) postHostMessage('window.drag.end');
    dragGesture.current = null;
    setIsDragging(false);
  };

  const handleCharacterKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    toggleInteractionMenu();
  };

  const priorityClass = activeReminder
    ? priorityClassNames[activeReminder.priority]
    : styles.priorityNormal;
  const isNight = hour >= 21 || hour < 7;
  const isSingleCharacter = activeCharacter.layout === 'single';
  // JSON string escaping prevents quotes in generated file URLs from breaking CSS.
  const characterImageStyle = {
    backgroundImage: `url(${JSON.stringify(activeCharacter.imageUrl)})`,
  };

  return (
    <section
      className={`${styles.stage} ${isPresenting ? styles.presentationStage : ''} ${
        isDragging ? styles.draggingStage : ''
      } ${priorityClass}`}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) setInteractionView('closed');
      }}
    >
      {celebrating && (
        <div className={styles.completionBurst} aria-live="polite">
          <strong>太棒啦！</strong>
          {['✦', '♥', '●', '◆', '✦', '♥', '●', '◆', '✦', '♥'].map((piece, index) => (
            <i key={`${piece}-${index}`}>{piece}</i>
          ))}
        </div>
      )}
      {isDragging && (
        <div
          className={`${styles.dragFrame} ${
            isSingleCharacter ? styles.singleDragFrame : styles.spriteSheetDragFrame
          }`}
          aria-hidden="true"
        />
      )}
      {!isPresenting && activeReminder && (
        <div
          className={`${styles.bubble} ${
            isSingleCharacter ? styles.bubbleSingleCharacter : ''
          } ${activeReminder ? styles.bubbleUrgent : ''}`}
        >
          <span className={styles.bubbleEyebrow}>
            {activeReminder.repeatRule === 'none'
              ? '提醒时间到'
              : '重复提醒时间到'}
          </span>
          <strong>{activeReminder.title}</strong>
          <div className={styles.bubbleActions}>
            <button type="button" onClick={completeReminder}>完成</button>
            <button type="button" onClick={snoozeReminder}>5 分钟后</button>
          </div>
        </div>
      )}

      {!isPresenting && !activeReminder && interactionView !== 'closed' && (
        <div
          className={`${styles.interactionCloud} ${
            interactionView === 'feedback' ? styles.interactionCloudFeedback : ''
          }`}
          role="dialog"
          aria-label={`${state.petName}互动菜单`}
        >
          <span className={styles.cloudEyebrow}>{state.petName}</span>
          {interactionView === 'choices' && (
            <>
              <strong>现在想做什么？</strong>
              <div className={styles.cloudChoices}>
                <button type="button" onClick={openDashboard}>
                  <span>▦</span><b>打开工作台</b><small>查看提醒和工具</small>
                </button>
                <button type="button" onClick={() => setInteractionView('actions')}>
                  <span>♡</span><b>和我互动</b><small>一起玩一会儿</small>
                </button>
              </div>
            </>
          )}
          {interactionView === 'actions' && (
            <>
              <strong>想和我怎么玩？</strong>
              <div className={styles.cloudActions}>
                <button type="button" onClick={() => requestPetAction('wave')}>挥挥手</button>
                <button type="button" onClick={() => requestPetAction('hop')}>跳一下</button>
                <button type="button" onClick={() => requestPetAction('walkRight')}>散散步</button>
                <button type="button" onClick={() => requestPetAction('petted')}>摸摸头</button>
                <button type="button" onClick={() => requestPetAction('sleepy')}>休息会</button>
                <button type="button" onClick={() => setInteractionView('choices')}>返回</button>
              </div>
            </>
          )}
          {interactionView === 'feedback' && (
            <strong className={styles.cloudFeedbackText}>{message}</strong>
          )}
        </div>
      )}

      {isPresenting && activeReminder && (
        <div className={styles.presentation} role="alert" aria-live="assertive">
          <div className={styles.spotlight} aria-hidden="true" />
          <span className={`${styles.sparkle} ${styles.sparkleOne}`} aria-hidden="true">✦</span>
          <span className={`${styles.sparkle} ${styles.sparkleTwo}`} aria-hidden="true">✦</span>
          <span className={`${styles.sparkle} ${styles.sparkleThree}`} aria-hidden="true">●</span>
          <span className={styles.urgencyRing} aria-hidden="true" />
          <span className={`${styles.alertRay} ${styles.alertRayOne}`} aria-hidden="true" />
          <span className={`${styles.alertRay} ${styles.alertRayTwo}`} aria-hidden="true" />

          <div className={styles.signBoard}>
            <span className={styles.signKicker}>
              {activeReminder.repeatRule === 'none'
                ? `${state.petName}提醒你`
                : `${state.petName}的重复提醒`}
            </span>
            <strong>{activeReminder.title}</strong>
            <span className={styles.signHint}>现在该做这件事啦</span>
            <div className={styles.signActions}>
              <button type="button" onClick={completeReminder}>完成啦</button>
              <button type="button" onClick={snoozeReminder}>5 分钟后</button>
            </div>
          </div>
          <div className={styles.signPost} aria-hidden="true" />
          <span className={styles.autoReturnHint}>稍后自动回到原位</span>
        </div>
      )}

      <div
        key={`${activeCharacter.id}-${actionCycle}`}
        className={`${styles.spriteShell} ${styles[action]} ${
          isSingleCharacter ? `${styles.singleCharacterShell} ${styles.customCharacter}` : ''
        }`}
        onPointerDown={beginCharacterPress}
        onPointerMove={continueCharacterPress}
        onPointerUp={endCharacterPress}
        onPointerCancel={cancelCharacterPress}
        onKeyDown={handleCharacterKey}
        role="button"
        tabIndex={isPresenting ? -1 : 0}
        aria-expanded={interactionView !== 'closed'}
        aria-label={`点击${state.petName}打开互动菜单，拖动可移动位置`}
      >
        <div
          className={`${styles.sprite} ${styles[action]} ${
            isSingleCharacter ? styles.singleSprite : ''
          }`}
          style={characterImageStyle}
        />
        <span className={`${styles.cheek} ${styles.cheekLeft}`} aria-hidden="true" />
        <span className={`${styles.cheek} ${styles.cheekRight}`} aria-hidden="true" />
        <div className={`${styles.outfit} ${isNight ? styles.nightOutfit : styles.dayOutfit}`} aria-hidden="true">
          <span className={styles.dayFlower}>✿</span>
          <span className={styles.nightCap}><i /></span>
        </div>
      </div>

      <div
        key={`effects-${actionCycle}`}
        className={`${styles.actionEffects} ${styles[action]} ${
          isSingleCharacter ? styles.singleCharacterEffects : ''
        }`}
        aria-hidden="true"
      >
        <span className={`${styles.heartFx} ${styles.heartOne}`}>♥</span>
        <span className={`${styles.heartFx} ${styles.heartTwo}`}>♥</span>
        <span className={`${styles.heartFx} ${styles.heartThree}`}>♥</span>
        <span className={`${styles.sleepFx} ${styles.sleepOne}`}>z</span>
        <span className={`${styles.sleepFx} ${styles.sleepTwo}`}>Z</span>
        <i className={`${styles.dustFx} ${styles.dustOne}`} />
        <i className={`${styles.dustFx} ${styles.dustTwo}`} />
        <span className={styles.hopFx}>✦</span>
      </div>

      {nextReminder && !activeReminder && !isPresenting && (
        <button
          className={styles.nextReminder}
          type="button"
          onClick={openDashboard}
        >
          <span>{formatShortTime(nextReminder.dueAt)}</span>
          <strong>{nextReminder.title}</strong>
        </button>
      )}
    </section>
  );
}
