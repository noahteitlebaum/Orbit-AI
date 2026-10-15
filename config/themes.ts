import type { ProviderId } from "./models";

// Per-provider chat themes. Colors and fonts live in app/globals.css under [data-theme="<provider>"];
// this file holds the layout differences (greeting, shapes) that make each one feel like the original app.
export interface ProviderTheme {
  appName: string;      // what the rail tile says
  monogram: string;     // letter on the tile when no logo file is set
  logo?: string;        // official logo in /public/providers
  logoMono?: boolean;   // logo is plain black: inverted to white in dark mode
  itemClass: string;    // shape of rows in the chat list
  inlineComposer?: boolean; // model menu + send on the same row as the input (Gemini)
  disclaimer: string;
  greeting: string;
  /** Greeting once we know the student's first name (hour = local hour, 0–23). */
  greetingFor?: (name: string, hour: number) => string;
  greetingLogo?: boolean; // the app's mark before the greeting (Claude)
  replyAvatar?: boolean;  // the app's mark beside each reply (Gemini)
  greetingClass: string;
  chipClass: string;    // starter suggestions under the empty-chat composer
  composerClass: string;
  sendClass: string;
  userBubbleClass: string;
  replyClass: string;
}

const timeOfDay = (h: number) => (h < 5 ? "Evening" : h < 12 ? "Morning" : h < 18 ? "Afternoon" : "Evening");

export const THEMES: Record<ProviderId, ProviderTheme> = {
  openai: {
    appName: "ChatGPT",
    monogram: "G",
    logo: "/providers/openai.webp",
    logoMono: true,
    itemClass: "rounded-lg",
    disclaimer: "ChatGPT can make mistakes. Check important info.",
    greeting: "What can I help with?",
    chipClass: "rounded-full border border-line px-3.5 py-2 text-sm text-ink-muted hover:bg-surface-200 hover:text-ink",
    greetingClass: "text-[24px] font-normal tracking-tight sm:text-[28px]",
    composerClass: "rounded-[28px] border border-line bg-composer shadow-composer",
    sendClass: "h-9 w-9 rounded-full",
    userBubbleClass: "rounded-3xl bg-bubble px-5 py-2.5",
    replyClass: "text-[16px] leading-7",
  },
  anthropic: {
    appName: "Claude",
    monogram: "C",
    logo: "/providers/claude.png",
    itemClass: "rounded-lg",
    disclaimer: "Claude can make mistakes. Please double-check responses.",
    greeting: "How can I help you today?",
    greetingFor: (name, h) => `${timeOfDay(h) === "Morning" ? "Good morning" : timeOfDay(h) === "Afternoon" ? "Good afternoon" : "Good evening"}, ${name}`,
    greetingLogo: true,
    chipClass: "rounded-lg border border-line bg-surface-000 px-3 py-1.5 text-sm text-ink-muted hover:border-line-strong hover:text-ink",
    greetingClass: "font-display text-[30px] font-light tracking-tight sm:text-[40px]",
    composerClass: "rounded-[20px] border border-line bg-composer shadow-composer",
    sendClass: "h-8 w-8 rounded-lg",
    userBubbleClass: "rounded-xl bg-bubble px-4 py-2.5",
    replyClass: "font-reply text-[17px] leading-[1.65]",
  },
  google: {
    appName: "Gemini",
    monogram: "G",
    logo: "/providers/gemini.webp",
    itemClass: "rounded-full",
    inlineComposer: true,
    disclaimer: "Gemini is AI and can make mistakes.",
    greeting: "Hello there",
    greetingFor: (name) => `Hello, ${name}`,
    replyAvatar: true,
    chipClass: "rounded-full bg-surface-200 px-4 py-2 text-sm text-ink hover:bg-surface-300",
    greetingClass: "gemini-gradient text-[34px] font-medium tracking-tight sm:text-[44px]",
    composerClass: "rounded-[36px] border border-transparent bg-composer shadow-composer",
    sendClass: "h-10 w-10 rounded-full",
    userBubbleClass: "rounded-[24px] rounded-tr-md bg-bubble px-5 py-3",
    replyClass: "text-[17px] leading-[1.75]",
  },
  xai: {
    appName: "Grok",
    monogram: "X",
    logo: "/providers/grok.webp",
    logoMono: true,
    itemClass: "rounded-xl",
    disclaimer: "Grok can make mistakes. Verify important information.",
    greeting: "What do you want to know?",
    greetingFor: (name, h) => `Good ${timeOfDay(h).toLowerCase()}, ${name}.`,
    chipClass: "rounded-full border border-line-strong px-3.5 py-2 text-sm text-ink-muted hover:bg-surface-200 hover:text-ink",
    greetingClass: "text-[26px] font-medium tracking-tight sm:text-[32px]",
    composerClass: "rounded-[28px] border border-line-strong bg-composer",
    sendClass: "h-9 w-9 rounded-full",
    userBubbleClass: "rounded-3xl rounded-br-lg border border-line bg-bubble px-5 py-2.5",
    replyClass: "text-[16px] leading-7",
  },
};
