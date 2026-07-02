/**
 * WorkspaceTabs - top-level project/workspace contexts
 */

import { getCurrentWindow } from "@tauri-apps/api/window";
import { html, nothing, render } from "lit";

export interface WorkspaceTabItem {
	id: string;
	title: string;
	subtitle?: string;
	closable?: boolean;
	color?: string | null;
	pinned?: boolean;
	emoji?: string | null;
}

const COLOR_PRESETS = [
	{ id: "red", value: "#8b4a46", label: "Red" },
	{ id: "green", value: "#4f755f", label: "Green" },
	{ id: "yellow", value: "#846a3f", label: "Yellow" },
	{ id: "blue", value: "#4d6f95", label: "Blue" },
	{ id: "purple", value: "#7a5891", label: "Purple" },
	{ id: "teal", value: "#4f8b8b", label: "Teal" },
] as const;

export type EmojiEntry = {
	emoji: string;
	name: string;
	keywords: string;
	search: string;
};

const EMOJI_CATALOG_RAW = [
	["😀", "grinning face", "smile happy grin"],
	["😃", "grinning face with big eyes", "smile happy joy"],
	["😄", "grinning face with smiling eyes", "smile happy laugh"],
	["😁", "beaming face with smiling eyes", "happy grin beam"],
	["😆", "grinning squinting face", "laugh haha funny"],
	["😅", "grinning face with sweat", "nervous relief laugh"],
	["🤣", "rolling on the floor laughing", "rofl laugh funny"],
	["😂", "face with tears of joy", "lol laugh crying"],
	["🙂", "slightly smiling face", "smile calm nice"],
	["🙃", "upside-down face", "silly playful"],
	["🫠", "melting face", "melt awkward hot"],
	["😉", "winking face", "wink playful"],
	["😊", "smiling face with smiling eyes", "blush warm kind"],
	["😇", "smiling face with halo", "angel innocent"],
	["🥰", "smiling face with hearts", "love adore"],
	["😍", "smiling face with heart-eyes", "love wow"],
	["🤩", "star-struck", "excited wow star"],
	["😘", "face blowing a kiss", "kiss love"],
	["😗", "kissing face", "kiss"],
	["☺️", "smiling face", "smile relaxed"],
	["😚", "kissing face with closed eyes", "kiss shy"],
	["😙", "kissing face with smiling eyes", "kiss smile"],
	["🥲", "smiling face with tear", "proud touched"],
	["😋", "face savoring food", "yum tasty"],
	["😛", "face with tongue", "silly playful"],
	["😜", "winking face with tongue", "joke silly"],
	["🤪", "zany face", "crazy goofy"],
	["😝", "squinting face with tongue", "silly goofy"],
	["🤑", "money-mouth face", "money rich"],
	["🤗", "hugging face", "hug friendly"],
	["🤭", "face with hand over mouth", "oops giggle"],
	["🫢", "face with open eyes and hand over mouth", "surprised gasp"],
	["🫣", "face with peeking eye", "peek shy"],
	["🤫", "shushing face", "quiet hush"],
	["🤔", "thinking face", "hmm question"],
	["🫡", "saluting face", "respect salute"],
	["🤐", "zipper-mouth face", "silent secret"],
	["🤨", "face with raised eyebrow", "skeptical doubt"],
	["😐", "neutral face", "meh"],
	["😑", "expressionless face", "blank"],
	["😶", "face without mouth", "speechless"],
	["🫥", "dotted line face", "disappear"],
	["😶‍🌫️", "face in clouds", "foggy absent"],
	["😏", "smirking face", "smirk"],
	["😒", "unamused face", "annoyed"],
	["🙄", "face with rolling eyes", "eyeroll"],
	["😬", "grimacing face", "awkward cringe"],
	["😮‍💨", "face exhaling", "relief sigh"],
	["🤥", "lying face", "lie"],
	["😌", "relieved face", "calm content"],
	["😔", "pensive face", "sad thoughtful"],
	["😪", "sleepy face", "tired"],
	["🤤", "drooling face", "want hungry"],
	["😴", "sleeping face", "sleep zzz"],
	["😷", "face with medical mask", "sick"],
	["🤒", "face with thermometer", "ill fever"],
	["🤕", "face with head-bandage", "hurt"],
	["🤢", "nauseated face", "gross sick"],
	["🤮", "face vomiting", "sick gross"],
	["🤧", "sneezing face", "cold"],
	["🥵", "hot face", "heat"],
	["🥶", "cold face", "freeze"],
	["🥴", "woozy face", "dizzy"],
	["😵", "face with crossed-out eyes", "dizzy"],
	["😵‍💫", "face with spiral eyes", "spiral dizzy"],
	["🤯", "exploding head", "mind blown"],
	["🤠", "cowboy hat face", "cowboy"],
	["🥳", "partying face", "party celebrate"],
	["🥸", "disguised face", "glasses costume"],
	["😎", "smiling face with sunglasses", "cool"],
	["🤓", "nerd face", "smart geek"],
	["🧐", "face with monocle", "inspect fancy"],
	["😕", "confused face", "confused"],
	["🫤", "face with diagonal mouth", "uncertain"],
	["😟", "worried face", "worry"],
	["🙁", "slightly frowning face", "sad"],
	["☹️", "frowning face", "sad frown"],
	["😮", "face with open mouth", "surprised"],
	["😯", "hushed face", "surprised quiet"],
	["😲", "astonished face", "wow shocked"],
	["😳", "flushed face", "embarrassed"],
	["🥺", "pleading face", "please puppy eyes"],
	["🥹", "face holding back tears", "teary emotional"],
	["😦", "frowning face with open mouth", "shocked"],
	["😧", "anguished face", "pain"],
	["😨", "fearful face", "scared"],
	["😰", "anxious face with sweat", "anxious nervous"],
	["😥", "sad but relieved face", "relief sad"],
	["😢", "crying face", "sad cry"],
	["😭", "loudly crying face", "sob cry"],
	["😱", "face screaming in fear", "scream"],
	["😖", "confounded face", "struggle"],
	["😣", "persevering face", "frustrated"],
	["😞", "disappointed face", "sad"],
	["😓", "downcast face with sweat", "stress"],
	["😩", "weary face", "tired upset"],
	["😫", "tired face", "exhausted"],
	["🥱", "yawning face", "sleepy"],
	["😤", "face with steam from nose", "determined angry"],
	["😡", "pouting face", "angry mad"],
	["😠", "angry face", "angry"],
	["🤬", "face with symbols on mouth", "swear rage"],
	["😈", "smiling face with horns", "devil"],
	["👿", "angry face with horns", "devil angry"],
	["💀", "skull", "dead spooky"],
	["☠️", "skull and crossbones", "danger poison"],
	["👻", "ghost", "spooky halloween"],
	["👽", "alien", "space"],
	["🤖", "robot", "bot ai"],
	["💩", "pile of poo", "poop funny"],
	["🐶", "dog face", "dog pet animal"],
	["🐱", "cat face", "cat pet animal"],
	["🐭", "mouse face", "mouse animal"],
	["🐹", "hamster face", "hamster pet"],
	["🐰", "rabbit face", "bunny"],
	["🦊", "fox", "fox animal"],
	["🐻", "bear", "bear animal"],
	["🐼", "panda", "panda animal"],
	["🐨", "koala", "koala animal"],
	["🐯", "tiger face", "tiger animal"],
	["🦁", "lion", "lion animal"],
	["🐮", "cow face", "cow animal"],
	["🐷", "pig face", "pig animal"],
	["🐸", "frog", "frog animal"],
	["🐵", "monkey face", "monkey animal"],
	["🐔", "chicken", "bird animal"],
	["🐧", "penguin", "penguin bird"],
	["🐦", "bird", "bird animal"],
	["🐤", "baby chick", "chick bird"],
	["🦄", "unicorn", "unicorn fantasy"],
	["🐝", "honeybee", "bee bug"],
	["🦋", "butterfly", "butterfly bug"],
	["🐢", "turtle", "turtle animal"],
	["🐙", "octopus", "ocean sea"],
	["🦀", "crab", "crab sea"],
	["🐬", "dolphin", "sea animal"],
	["🐳", "spouting whale", "whale sea"],
	["🦭", "seal", "seal sea"],
	["🌱", "seedling", "plant grow"],
	["🌿", "herb", "plant green"],
	["🍀", "four leaf clover", "luck plant"],
	["🌵", "cactus", "desert plant"],
	["🌴", "palm tree", "tree vacation"],
	["🌳", "deciduous tree", "tree nature"],
	["🌲", "evergreen tree", "tree pine"],
	["🌸", "cherry blossom", "flower pink"],
	["🌼", "blossom", "flower yellow"],
	["🌻", "sunflower", "flower sun"],
	["🌞", "sun with face", "sun weather"],
	["🌝", "full moon face", "moon night"],
	["🌈", "rainbow", "rainbow color"],
	["⭐", "star", "star favorite"],
	["✨", "sparkles", "sparkle magic"],
	["⚡", "high voltage", "lightning energy"],
	["🔥", "fire", "fire hot"],
	["☄️", "comet", "space star"],
	["🌊", "water wave", "wave ocean"],
	["🍎", "red apple", "fruit apple"],
	["🍊", "tangerine", "orange fruit"],
	["🍋", "lemon", "fruit sour"],
	["🍉", "watermelon", "fruit summer"],
	["🍇", "grapes", "fruit"],
	["🍓", "strawberry", "fruit berry"],
	["🫐", "blueberries", "fruit berry"],
	["🍒", "cherries", "fruit"],
	["🍍", "pineapple", "fruit tropical"],
	["🥭", "mango", "fruit tropical"],
	["🥑", "avocado", "food"],
	["🍔", "hamburger", "burger food"],
	["🍟", "french fries", "fries food"],
	["🍕", "pizza", "food slice"],
	["🌮", "taco", "food mexican"],
	["🌯", "burrito", "food mexican"],
	["🥪", "sandwich", "food lunch"],
	["🍣", "sushi", "food japan"],
	["🍜", "steaming bowl", "ramen noodles"],
	["☕", "hot beverage", "coffee drink"],
	["🍵", "teacup without handle", "tea drink"],
	["🧋", "bubble tea", "boba drink"],
	["🥤", "cup with straw", "drink soda"],
	["🍺", "beer mug", "beer drink"],
	["🍷", "wine glass", "wine drink"],
	["🥂", "clinking glasses", "celebrate toast"],
	["🧠", "brain", "brain thinking"],
	["💬", "speech balloon", "chat talk"],
	["💭", "thought balloon", "thought idea"],
	["💡", "light bulb", "idea bright"],
	["🔦", "flashlight", "light tool"],
	["🕯️", "candle", "light calm"],
	["💻", "laptop", "computer work"],
	["🖥️", "desktop computer", "computer desktop"],
	["⌨️", "keyboard", "typing"],
	["🖱️", "computer mouse", "mouse computer"],
	["📱", "mobile phone", "phone smartphone"],
	["☎️", "telephone", "phone call"],
	["📷", "camera", "photo"],
	["📸", "camera with flash", "photo"],
	["🎥", "movie camera", "video film"],
	["🎧", "headphone", "music audio"],
	["🎤", "microphone", "audio sing"],
	["📦", "package", "box shipping"],
	["📁", "file folder", "folder file"],
	["🗂️", "card index dividers", "organize"],
	["📝", "memo", "write notes"],
	["📓", "notebook", "notes"],
	["📚", "books", "read study"],
	["📌", "pushpin", "pin mark"],
	["✂️", "scissors", "cut"],
	["🖌️", "paintbrush", "paint art"],
	["🎨", "artist palette", "art color"],
	["🧰", "toolbox", "tools fix"],
	["🔧", "wrench", "tool fix"],
	["🔨", "hammer", "tool build"],
	["🪛", "screwdriver", "tool fix"],
	["🛠️", "hammer and wrench", "repair build"],
	["⚙️", "gear", "settings tool"],
	["🔒", "locked", "secure private"],
	["🔓", "unlocked", "open secure"],
	["🔑", "key", "access unlock"],
	["🪄", "magic wand", "magic creative"],
	["🎯", "bullseye", "target focus"],
	["🏁", "chequered flag", "finish race"],
	["🚀", "rocket", "launch space"],
	["🛰️", "satellite", "space orbit"],
	["✈️", "airplane", "travel flight"],
	["🚗", "automobile", "car drive"],
	["🚲", "bicycle", "bike ride"],
	["🛸", "flying saucer", "ufo space"],
	["🏠", "house", "home"],
	["🏡", "house with garden", "home"],
	["🏢", "office building", "office work"],
	["🌃", "night with stars", "city night"],
	["🌅", "sunrise", "morning"],
	["🏝️", "desert island", "island vacation"],
	["🏔️", "snow-capped mountain", "mountain nature"],
	["🧭", "compass", "navigate direction"],
	["⏳", "hourglass", "time waiting"],
	["⌛", "hourglass done", "time"],
	["⏰", "alarm clock", "clock time"],
	["📅", "calendar", "date schedule"],
	["✅", "check mark button", "done yes"],
	["🆕", "new button", "new fresh"],
	["❗", "exclamation mark", "important"],
	["❓", "question mark", "question"],
	["❤️", "red heart", "love heart"],
	["🧡", "orange heart", "heart"],
	["💛", "yellow heart", "heart"],
	["💚", "green heart", "heart"],
	["🩵", "light blue heart", "heart"],
	["💙", "blue heart", "heart"],
	["💜", "purple heart", "heart"],
	["🖤", "black heart", "heart"],
	["🤍", "white heart", "heart"],
	["🤎", "brown heart", "heart"],
	["💥", "collision", "boom"],
	["🎉", "party popper", "celebrate party"],
	["🎊", "confetti ball", "celebrate party"],
	["🏆", "trophy", "win award"],
	["🥇", "first place medal", "gold award"],
	["🎮", "video game", "gaming"],
	["🧩", "puzzle piece", "puzzle"],
	["♟️", "chess pawn", "chess strategy"],
	["🎵", "musical note", "music"],
	["🎶", "musical notes", "music"],
	["📈", "chart increasing", "growth analytics"],
	["📉", "chart decreasing", "analytics"],
] as const;

export const EMOJI_CATALOG: EmojiEntry[] = EMOJI_CATALOG_RAW.map(([emoji, name, keywords]) => ({
	emoji,
	name,
	keywords,
	search: `${emoji} ${name} ${keywords}`.toLowerCase(),
}));
const DRAG_START_THRESHOLD_PX = 6;

export class WorkspaceTabs {
	private container: HTMLElement;
	private tabs: WorkspaceTabItem[] = [];
	private activeId: string | null = null;
	private onSelect: ((id: string) => void) | null = null;
	private onClose: ((id: string) => void) | null = null;
	private onRename: ((id: string, title: string) => void) | null = null;
	private onColor: ((id: string, color: string | null) => void) | null = null;
	private onPin: ((id: string, pinned: boolean) => void) | null = null;
	private onEmoji: ((id: string, emoji: string | null) => void) | null = null;
	private onReorder: ((orderedIds: string[]) => void) | null = null;
	private onAdd: (() => void) | null = null;
	private onToggleSidebar: (() => void) | null = null;
	private onPackagesSearchInput: ((query: string) => void) | null = null;
	private onPackagesCatalog: (() => void) | null = null;
	private onPackagesRefresh: (() => void) | null = null;
	private sidebarCollapsed = false;
	private packagesToolbarVisible = false;
	private packagesSearchQuery = "";
	private contextWorkspaceId: string | null = null;
	private contextX = 0;
	private contextY = 0;
	private renamingWorkspaceId: string | null = null;
	private renameDraftValue = "";
	private emojiPickerWorkspaceId: string | null = null;
	private emojiPickerX = 0;
	private emojiPickerY = 0;
	private emojiSearchQuery = "";
	private pendingDragWorkspaceId: string | null = null;
	private pendingDragPointerId: number | null = null;
	private dragStartX = 0;
	private dragCurrentX = 0;
	private dragGrabOffsetX = 0;
	private draggingWorkspaceId: string | null = null;
	private dragGhostWidth = 0;
	private previewTabs: WorkspaceTabItem[] | null = null;
	private suppressClickWorkspaceId: string | null = null;
	private suppressClickUntil = 0;
	private readonly onWindowPointerDown = (event: PointerEvent) => {
		const target = event.target as HTMLElement | null;
		if (target?.closest(".content-tab-context-menu")) return;
		if (target?.closest(".workspace-emoji-picker")) return;
		if (target?.closest(".workspace-tab-emoji-button")) return;
		let changed = false;
		if (this.contextWorkspaceId) {
			this.contextWorkspaceId = null;
			changed = true;
		}
		if (this.emojiPickerWorkspaceId) {
			this.emojiPickerWorkspaceId = null;
			this.emojiSearchQuery = "";
			changed = true;
		}
		if (changed) {
			window.removeEventListener("pointerdown", this.onWindowPointerDown, true);
			this.render();
		}
	};
	private readonly onWindowPointerMove = (event: PointerEvent) => {
		if (event.pointerId !== this.pendingDragPointerId) return;
		if (!this.pendingDragWorkspaceId) return;
		const deltaX = event.clientX - this.dragStartX;
		if (!this.draggingWorkspaceId) {
			if (Math.abs(deltaX) < DRAG_START_THRESHOLD_PX) return;
			this.activateWorkspaceDrag(this.pendingDragWorkspaceId);
		}
		this.dragCurrentX = event.clientX;
		this.updatePreviewOrderFromPointer();
		this.render();
	};
	private readonly onWindowPointerUp = (event: PointerEvent) => {
		if (event.pointerId !== this.pendingDragPointerId) return;
		this.finishWorkspacePointerInteraction();
	};

	constructor(container: HTMLElement) {
		this.container = container;
		this.render();
	}

	setTabs(tabs: WorkspaceTabItem[], activeId: string | null): void {
		this.tabs = tabs;
		this.activeId = activeId;
		if (this.contextWorkspaceId && !this.tabs.some((tab) => tab.id === this.contextWorkspaceId)) {
			this.contextWorkspaceId = null;
		}
		if (this.emojiPickerWorkspaceId && !this.tabs.some((tab) => tab.id === this.emojiPickerWorkspaceId)) {
			this.emojiPickerWorkspaceId = null;
			this.emojiSearchQuery = "";
		}
		if (this.renamingWorkspaceId && !this.tabs.some((tab) => tab.id === this.renamingWorkspaceId)) {
			this.renamingWorkspaceId = null;
			this.renameDraftValue = "";
		}
		if (this.draggingWorkspaceId && !this.tabs.some((tab) => tab.id === this.draggingWorkspaceId)) {
			this.clearDragState();
		}
		this.render();
	}

	setOnSelect(cb: (id: string) => void): void {
		this.onSelect = cb;
	}

	setOnClose(cb: (id: string) => void): void {
		this.onClose = cb;
	}

	setOnRename(cb: (id: string, title: string) => void): void {
		this.onRename = cb;
	}

	setOnColor(cb: (id: string, color: string | null) => void): void {
		this.onColor = cb;
	}

	setOnPin(cb: (id: string, pinned: boolean) => void): void {
		this.onPin = cb;
	}

	setOnEmoji(cb: (id: string, emoji: string | null) => void): void {
		this.onEmoji = cb;
	}

	setOnReorder(cb: (orderedIds: string[]) => void): void {
		this.onReorder = cb;
	}

	setOnAdd(cb: () => void): void {
		this.onAdd = cb;
	}

	setOnToggleSidebar(cb: () => void): void {
		this.onToggleSidebar = cb;
	}

	setOnPackagesSearchInput(cb: (query: string) => void): void {
		this.onPackagesSearchInput = cb;
	}

	setOnPackagesCatalog(cb: () => void): void {
		this.onPackagesCatalog = cb;
	}

	setOnPackagesRefresh(cb: () => void): void {
		this.onPackagesRefresh = cb;
	}

	setSidebarCollapsed(collapsed: boolean): void {
		if (this.sidebarCollapsed === collapsed) return;
		this.sidebarCollapsed = collapsed;
		this.render();
	}

	setPackagesToolbarVisible(visible: boolean): void {
		if (this.packagesToolbarVisible === visible) return;
		this.packagesToolbarVisible = visible;
		this.render();
	}

	setPackagesSearchQuery(query: string): void {
		if (this.packagesSearchQuery === query) return;
		this.packagesSearchQuery = query;
		this.render();
	}

	private async minimize(): Promise<void> {
		try {
			await getCurrentWindow().minimize();
		} catch {
			// noop in browser fallback
		}
	}

	private async maximize(): Promise<void> {
		try {
			await getCurrentWindow().toggleMaximize();
		} catch {
			// noop in browser fallback
		}
	}

	private async close(): Promise<void> {
		try {
			await getCurrentWindow().close();
		} catch {
			// noop in browser fallback
		}
	}

	private getRenderedTabs(): WorkspaceTabItem[] {
		return this.previewTabs ?? this.tabs;
	}

	private getWorkspaceById(workspaceId: string | null): WorkspaceTabItem | null {
		if (!workspaceId) return null;
		return this.tabs.find((tab) => tab.id === workspaceId) ?? null;
	}

	private openContext(tab: WorkspaceTabItem, event: MouseEvent): void {
		event.preventDefault();
		this.closeEmojiPicker(false);
		this.contextWorkspaceId = tab.id;
		const menuWidth = 228;
		const menuHeight = 182;
		const pad = 10;
		this.contextX = Math.min(Math.max(pad, event.clientX + 6), Math.max(pad, window.innerWidth - menuWidth - pad));
		this.contextY = Math.min(Math.max(pad, event.clientY + 6), Math.max(pad, window.innerHeight - menuHeight - pad));
		window.removeEventListener("pointerdown", this.onWindowPointerDown, true);
		window.addEventListener("pointerdown", this.onWindowPointerDown, true);
		this.render();
	}

	private closeContext(shouldRender = true): void {
		if (!this.contextWorkspaceId) return;
		this.contextWorkspaceId = null;
		if (!this.emojiPickerWorkspaceId) {
			window.removeEventListener("pointerdown", this.onWindowPointerDown, true);
		}
		if (shouldRender) this.render();
	}

	private openEmojiPicker(workspaceId: string, event: MouseEvent): void {
		event.preventDefault();
		event.stopPropagation();
		const button = event.currentTarget as HTMLElement | null;
		const rect = button?.getBoundingClientRect();
		this.openEmojiPickerAt(workspaceId, rect?.left ?? event.clientX, rect?.bottom ?? event.clientY);
	}

	private openEmojiPickerAt(workspaceId: string, anchorLeft: number, anchorBottom: number): void {
		const workspace = this.getWorkspaceById(workspaceId);
		if (!workspace) return;
		this.closeContext(false);
		this.emojiPickerWorkspaceId = workspaceId;
		this.emojiSearchQuery = "";
		const pickerWidth = 272;
		const pickerHeight = 332;
		const pad = 10;
		this.emojiPickerX = Math.min(Math.max(pad, anchorLeft - 8), Math.max(pad, window.innerWidth - pickerWidth - pad));
		this.emojiPickerY = Math.min(Math.max(pad, anchorBottom + 8), Math.max(pad, window.innerHeight - pickerHeight - pad));
		window.removeEventListener("pointerdown", this.onWindowPointerDown, true);
		window.addEventListener("pointerdown", this.onWindowPointerDown, true);
		this.render();
		requestAnimationFrame(() => {
			const input = this.container.querySelector<HTMLInputElement>(`.workspace-emoji-search[data-workspace-id="${workspaceId}"]`);
			input?.focus();
			input?.select();
		});
	}

	private closeEmojiPicker(shouldRender = true): void {
		if (!this.emojiPickerWorkspaceId) return;
		this.emojiPickerWorkspaceId = null;
		this.emojiSearchQuery = "";
		if (!this.contextWorkspaceId) {
			window.removeEventListener("pointerdown", this.onWindowPointerDown, true);
		}
		if (shouldRender) this.render();
	}

	private normalizeEmoji(value: string | null | undefined): string | null {
		if (!value) return null;
		const trimmed = value.trim();
		if (!trimmed) return null;
		try {
			const SegmenterCtor = (Intl as typeof Intl & { Segmenter?: typeof Intl.Segmenter }).Segmenter;
			if (SegmenterCtor) {
				const segmenter = new SegmenterCtor(undefined, { granularity: "grapheme" });
				const first = segmenter.segment(trimmed)[Symbol.iterator]().next().value?.segment;
				if (first) return first;
			}
		} catch {
			// fall through
		}
		return [...trimmed].slice(0, 4).join("");
	}

	private applyWorkspaceEmoji(workspaceId: string, emoji: string | null): void {
		this.onEmoji?.(workspaceId, this.normalizeEmoji(emoji));
		this.closeEmojiPicker();
	}

	private getFilteredEmojiCatalog(): EmojiEntry[] {
		const query = this.emojiSearchQuery.trim().toLowerCase();
		if (!query) return EMOJI_CATALOG;
		return EMOJI_CATALOG.filter((entry) => entry.search.includes(query));
	}

	private startRenameWorkspace(workspaceId: string): void {
		const tab = this.getWorkspaceById(workspaceId);
		if (!tab) return;
		this.closeContext(false);
		this.closeEmojiPicker(false);
		this.renamingWorkspaceId = workspaceId;
		this.renameDraftValue = tab.title;
		this.render();
		requestAnimationFrame(() => {
			const input = this.container.querySelector<HTMLInputElement>(`.workspace-tab-inline-input[data-workspace-id="${workspaceId}"]`);
			input?.focus();
			input?.select();
		});
	}

	private commitRenameWorkspace(): void {
		const workspaceId = this.renamingWorkspaceId;
		if (!workspaceId) return;
		const tab = this.getWorkspaceById(workspaceId);
		const nextTitle = this.renameDraftValue.trim();
		this.renamingWorkspaceId = null;
		this.renameDraftValue = "";
		if (tab && nextTitle && nextTitle !== tab.title) {
			this.onRename?.(workspaceId, nextTitle);
		}
		this.render();
	}

	private cancelRenameWorkspace(): void {
		if (!this.renamingWorkspaceId) return;
		this.renamingWorkspaceId = null;
		this.renameDraftValue = "";
		this.render();
	}

	private closeContextWorkspace(): void {
		const tab = this.getWorkspaceById(this.contextWorkspaceId);
		if (!tab) {
			this.closeContext();
			return;
		}
		if (tab.closable) {
			this.onClose?.(tab.id);
		}
		this.closeContext();
	}

	private toggleContextWorkspacePinned(): void {
		const tab = this.getWorkspaceById(this.contextWorkspaceId);
		if (!tab) {
			this.closeContext();
			return;
		}
		this.onPin?.(tab.id, !Boolean(tab.pinned));
		this.closeContext();
	}

	private setContextWorkspaceColor(color: string | null): void {
		const tab = this.getWorkspaceById(this.contextWorkspaceId);
		if (!tab) {
			this.closeContext();
			return;
		}
		this.onColor?.(tab.id, color);
		this.closeContext();
	}

	private clearDragState(shouldRender = false): void {
		this.pendingDragWorkspaceId = null;
		this.pendingDragPointerId = null;
		this.dragStartX = 0;
		this.dragCurrentX = 0;
		this.dragGrabOffsetX = 0;
		this.draggingWorkspaceId = null;
		this.dragGhostWidth = 0;
		this.previewTabs = null;
		window.removeEventListener("pointermove", this.onWindowPointerMove, true);
		window.removeEventListener("pointerup", this.onWindowPointerUp, true);
		if (shouldRender) this.render();
	}

	private beginWorkspacePointerInteraction(workspaceId: string, event: PointerEvent): void {
		if (event.button !== 0) return;
		if (this.renamingWorkspaceId) return;
		const target = event.target as HTMLElement | null;
		if (target?.closest(".workspace-tab-close")) return;
		if (target?.closest(".workspace-tab-emoji-button")) return;
		if (target?.closest("input")) return;
		const tabElement = (event.currentTarget as HTMLElement | null) ?? this.container.querySelector<HTMLElement>(`.workspace-tab[data-workspace-id="${workspaceId}"]`);
		const rect = tabElement?.getBoundingClientRect();
		this.pendingDragWorkspaceId = workspaceId;
		this.pendingDragPointerId = event.pointerId;
		this.dragStartX = event.clientX;
		this.dragCurrentX = event.clientX;
		this.dragGrabOffsetX = rect ? event.clientX - rect.left : 0;
		window.addEventListener("pointermove", this.onWindowPointerMove, true);
		window.addEventListener("pointerup", this.onWindowPointerUp, true);
	}

	private activateWorkspaceDrag(workspaceId: string): void {
		const tab = this.getWorkspaceById(workspaceId);
		if (!tab) return;
		const element = this.container.querySelector<HTMLElement>(`.workspace-tab[data-workspace-id="${workspaceId}"]`);
		const rect = element?.getBoundingClientRect();
		this.draggingWorkspaceId = workspaceId;
		this.dragGhostWidth = rect?.width ?? 168;
		this.previewTabs = [...this.tabs];
		this.closeContext(false);
		this.closeEmojiPicker(false);
	}

	private updatePreviewOrderFromPointer(): void {
		const draggedId = this.draggingWorkspaceId;
		const previewTabs = this.previewTabs;
		if (!draggedId || !previewTabs) return;
		const draggedTab = previewTabs.find((tab) => tab.id === draggedId);
		if (!draggedTab) return;
		const sameGroupTabs = previewTabs.filter((tab) => Boolean(tab.pinned) === Boolean(draggedTab.pinned));
		const otherTabs = sameGroupTabs.filter((tab) => tab.id !== draggedId);
		let insertIndex = 0;
		for (const tab of otherTabs) {
			const element = this.container.querySelector<HTMLElement>(`.workspace-tab[data-workspace-id="${tab.id}"]`);
			const rect = element?.getBoundingClientRect();
			if (!rect) continue;
			const centerX = rect.left + rect.width / 2;
			if (this.dragCurrentX > centerX) {
				insertIndex += 1;
			}
		}
		const reorderedGroup = [...otherTabs];
		reorderedGroup.splice(insertIndex, 0, draggedTab);
		const pinnedGroup = draggedTab.pinned ? reorderedGroup : previewTabs.filter((tab) => tab.pinned);
		const unpinnedGroup = draggedTab.pinned ? previewTabs.filter((tab) => !tab.pinned) : reorderedGroup;
		const nextPreviewTabs = [...pinnedGroup, ...unpinnedGroup];
		const currentIds = previewTabs.map((tab) => tab.id).join("|");
		const nextIds = nextPreviewTabs.map((tab) => tab.id).join("|");
		if (currentIds !== nextIds) {
			this.previewTabs = nextPreviewTabs;
		}
	}

	private finishWorkspacePointerInteraction(): void {
		const draggingId = this.draggingWorkspaceId;
		const previewTabs = this.previewTabs;
		const initialIds = this.tabs.map((tab) => tab.id).join("|");
		const finalIds = previewTabs?.map((tab) => tab.id).join("|") ?? initialIds;
		const orderChanged = Boolean(draggingId && previewTabs && finalIds !== initialIds);
		this.clearDragState(false);
		if (draggingId) {
			this.suppressClickWorkspaceId = draggingId;
			this.suppressClickUntil = Date.now() + 250;
		}
		if (orderChanged && previewTabs) {
			this.onReorder?.(previewTabs.map((tab) => tab.id));
		}
		this.render();
	}

	private shouldSuppressWorkspaceClick(workspaceId: string): boolean {
		if (this.suppressClickWorkspaceId !== workspaceId) return false;
		if (Date.now() > this.suppressClickUntil) {
			this.suppressClickWorkspaceId = null;
			this.suppressClickUntil = 0;
			return false;
		}
		this.suppressClickWorkspaceId = null;
		this.suppressClickUntil = 0;
		return true;
	}

	private getDragGhostLeft(): number {
		const scroll = this.container.querySelector<HTMLElement>(".workspace-tabs-scroll");
		if (!scroll) return 0;
		const rect = scroll.getBoundingClientRect();
		return this.dragCurrentX - this.dragGrabOffsetX - rect.left + scroll.scrollLeft;
	}

	private updateLayoutMetrics(): void {
		const root = this.container.querySelector<HTMLElement>(".workspace-tabs-root");
		const left = this.container.querySelector<HTMLElement>(".workspace-tabs-left");
		if (!root || !left) return;
		const rootRect = root.getBoundingClientRect();
		const leftRect = left.getBoundingClientRect();
		const rootStyles = window.getComputedStyle(root);
		const gap = Number.parseFloat(rootStyles.columnGap || rootStyles.gap || "0") || 0;
		const baseStart = Math.max(0, Math.round(leftRect.left - rootRect.left + leftRect.width + gap));
		this.container.style.setProperty("--workspace-topbar-main-start-base", `${baseStart}px`);
	}

	private renderWorkspaceTab(tab: WorkspaceTabItem, index: number, placeholder = false): ReturnType<typeof html> {
		const renderedTabs = this.getRenderedTabs();
		const color = tab.color ?? "";
		const renaming = this.renamingWorkspaceId === tab.id;
		const nextTab = renderedTabs[index + 1] ?? null;
		const pinnedBoundary = Boolean(tab.pinned && (!nextTab || !nextTab.pinned));
		const isEmojiPickerOpen = this.emojiPickerWorkspaceId === tab.id;
		return html`
			<div
				class="workspace-tab ${this.activeId === tab.id ? "active" : ""} ${color ? "has-color" : ""} ${tab.pinned ? "pinned" : ""} ${tab.emoji ? "has-emoji" : ""} ${pinnedBoundary ? "pinned-boundary" : ""} ${placeholder ? "workspace-tab-placeholder" : ""}"
				style=${color ? `--workspace-tab-fill:${color};` : ""}
				data-workspace-id=${tab.id}
				@contextmenu=${(event: MouseEvent) => this.openContext(tab, event)}
				@pointerdown=${(event: PointerEvent) => this.beginWorkspacePointerInteraction(tab.id, event)}
			>
				${placeholder
					? html`<div class="workspace-tab-main workspace-tab-main-placeholder"></div>`
					: html`
						<button
							class="workspace-tab-emoji-button ${tab.emoji ? "filled" : "empty"} ${isEmojiPickerOpen ? "open" : ""}"
							title="Change workspace emoji"
							@click=${(event: MouseEvent) => this.openEmojiPicker(tab.id, event)}
						>
							${tab.emoji ?? "✨"}
						</button>
						<button
							class="workspace-tab-main"
							@click=${() => {
								if (renaming) return;
								if (this.shouldSuppressWorkspaceClick(tab.id)) return;
								this.onSelect?.(tab.id);
							}}
							title=${tab.subtitle || tab.title}
						>
							${renaming
								? html`
									<input
										class="workspace-tab-inline-input"
										data-workspace-id=${tab.id}
										.value=${this.renameDraftValue}
										@click=${(event: Event) => event.stopPropagation()}
										@input=${(event: Event) => {
											this.renameDraftValue = (event.target as HTMLInputElement).value;
										}}
										@keydown=${(event: KeyboardEvent) => {
											if (event.key === "Enter") {
												event.preventDefault();
												this.commitRenameWorkspace();
												return;
											}
											if (event.key === "Escape") {
												event.preventDefault();
												this.cancelRenameWorkspace();
											}
										}}
										@blur=${() => this.commitRenameWorkspace()}
										autofocus
									/>
								`
								: html`<span class="workspace-tab-title">${tab.title}</span>`}
						</button>
						${tab.closable
							? html`<button
								class="workspace-tab-close"
								@click=${(event: Event) => {
									event.stopPropagation();
									this.onClose?.(tab.id);
								}}
								title="Close workspace"
							>
								✕
							</button>`
							: nothing}
					`}
			</div>
		`;
	}

	render(): void {
		const contextWorkspace = this.getWorkspaceById(this.contextWorkspaceId);
		const emojiPickerWorkspace = this.getWorkspaceById(this.emojiPickerWorkspaceId);
		const filteredEmojiCatalog = this.getFilteredEmojiCatalog();
		const renderedTabs = this.getRenderedTabs();
		const draggingWorkspace = this.getWorkspaceById(this.draggingWorkspaceId);
		const dragGhostLeft = this.draggingWorkspaceId ? this.getDragGhostLeft() : 0;
		const template = html`
			<div class="workspace-tabs-root" data-tauri-drag-region>
				<div class="workspace-tabs-left" data-tauri-drag-region>
					<div class="window-controls" data-tauri-drag-region>
						<button class="window-dot red" title="Close" @click=${() => this.close()}></button>
						<button class="window-dot yellow" title="Minimize" @click=${() => this.minimize()}></button>
						<button class="window-dot green" title="Maximize" @click=${() => this.maximize()}></button>
					</div>

					<button
						class="workspace-sidebar-toggle ${this.sidebarCollapsed ? "collapsed" : ""}"
						title=${this.sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
						@click=${() => this.onToggleSidebar?.()}
					>
						<svg viewBox="0 0 16 16" aria-hidden="true">
							<rect x="2.5" y="3" width="4" height="10" rx="1.2"></rect>
							<rect x="8" y="3" width="5.5" height="10" rx="1.2"></rect>
						</svg>
					</button>
				</div>

				<div class="workspace-tabs-main" data-tauri-drag-region>
					<div class="workspace-tabs-scroll ${this.draggingWorkspaceId ? "is-dragging" : ""}" data-tauri-drag-region>
						${renderedTabs.map((tab, index) => this.renderWorkspaceTab(tab, index, this.draggingWorkspaceId === tab.id))}
						${draggingWorkspace
							? html`
								<div class="workspace-tab workspace-tab-drag-ghost ${draggingWorkspace.color ? "has-color" : ""} ${this.activeId === draggingWorkspace.id ? "active" : ""} ${draggingWorkspace.emoji ? "has-emoji" : ""}" style=${`${draggingWorkspace.color ? `--workspace-tab-fill:${draggingWorkspace.color};` : ""}left:${dragGhostLeft}px;width:${this.dragGhostWidth}px;`}>
									<div class="workspace-tab-emoji-button ${draggingWorkspace.emoji ? "filled" : "empty"}">${draggingWorkspace.emoji ?? "✨"}</div>
									<div class="workspace-tab-main"><span class="workspace-tab-title">${draggingWorkspace.title}</span></div>
								</div>
							`
							: nothing}
					</div>
					${this.packagesToolbarVisible
						? nothing
						: html`<button class="workspace-tab-add" @click=${() => this.onAdd?.()} title="New workspace">＋</button>`}
					${this.packagesToolbarVisible
						? html`
							<div class="workspace-context-actions">
								<input
									class="workspace-context-search"
									type="text"
									placeholder="Search packages"
									.value=${this.packagesSearchQuery}
									@input=${(e: Event) => this.onPackagesSearchInput?.((e.target as HTMLInputElement).value)}
								/>
								<button class="workspace-context-btn" title="Open catalog" @click=${() => this.onPackagesCatalog?.()}>
									<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3h7v7"></path><path d="M13 3L5.5 10.5"></path><path d="M12.5 8.8v3.2a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3.2"></path></svg>
								</button>
								<button class="workspace-context-btn" title="Refresh packages" @click=${() => this.onPackagesRefresh?.()}>
									<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M12.7 8a4.7 4.7 0 1 1-1.4-3.4"></path><path d="M12.7 4.2v2.4h-2.4"></path></svg>
								</button>
							</div>
						`
						: nothing}
				</div>

				${this.contextWorkspaceId
					? html`
						<div class="content-tab-context-menu workspace-tab-context-menu" style=${`left:${this.contextX}px;top:${this.contextY}px`} @click=${(e: Event) => e.stopPropagation()}>
							<button class="content-tab-context-action" @click=${() => this.startRenameWorkspace(this.contextWorkspaceId!)}>Rename workspace</button>
							<button class="content-tab-context-action" @click=${() => this.toggleContextWorkspacePinned()}>${contextWorkspace?.pinned ? "Unpin workspace" : "Pin workspace"}</button>
							<button class="content-tab-context-action" ?disabled=${!contextWorkspace?.closable} @click=${() => this.closeContextWorkspace()}>Close workspace</button>
							<div class="content-tab-context-divider"></div>
							<div class="content-tab-context-title">Workspace color</div>
							<div class="content-tab-context-colors">
								<button class="tab-color-swatch reset" title="Default" @click=${() => this.setContextWorkspaceColor(null)}>×</button>
								${COLOR_PRESETS.map(
									(color) => html`
										<button
											class="tab-color-swatch"
											style=${`--swatch:${color.value}`}
											title=${color.label}
											@click=${() => this.setContextWorkspaceColor(color.value)}
										></button>
									`,
								)}
							</div>
						</div>
					`
					: nothing}

				${this.emojiPickerWorkspaceId
					? html`
						<div class="workspace-emoji-picker" style=${`left:${this.emojiPickerX}px;top:${this.emojiPickerY}px`} @click=${(event: Event) => event.stopPropagation()}>
							<input
								class="workspace-emoji-search"
								data-workspace-id=${this.emojiPickerWorkspaceId}
								type="text"
								placeholder="Search emojis"
								.value=${this.emojiSearchQuery}
								@input=${(event: Event) => {
									this.emojiSearchQuery = (event.target as HTMLInputElement).value;
									this.render();
								}}
								@keydown=${(event: KeyboardEvent) => {
									if (event.key === "Escape") {
										event.preventDefault();
										this.closeEmojiPicker();
									}
								}}
							/>
							<div class="workspace-emoji-scroll">
								<div class="workspace-emoji-grid">
									${filteredEmojiCatalog.length > 0
										? filteredEmojiCatalog.map(
											(entry) => html`<button
												class="workspace-emoji-swatch ${emojiPickerWorkspace?.emoji === entry.emoji ? "selected" : ""}"
												title=${entry.name}
												@click=${() => this.applyWorkspaceEmoji(this.emojiPickerWorkspaceId!, entry.emoji)}
											>${entry.emoji}</button>`,
										)
										: html`<div class="workspace-emoji-empty">No emojis found</div>`}
								</div>
							</div>
						</div>
					`
					: nothing}
			</div>
		`;

		render(template, this.container);
		requestAnimationFrame(() => this.updateLayoutMetrics());
	}
}
