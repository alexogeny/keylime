import type { Shoe } from "../types.js";

export const ALTRA: Shoe[] = [
  {
    id: "altra-torin",
    brand: "Altra",
    model: "Torin",
    category: "neutral",
    cushion: "high",
    variants: [
      {
        version: "7",
        year: 2024,
        spec: { heelStack: 28, forefootStack: 28, drop: 0, weightGrams: 275, msrp: 145 },
        foam: "Altra EGO",
        plate: { present: false },
        surfaces: ["road"],
        rocker: false,
        features: ["zero drop", "foot-shaped (wide) toe box", "balanced cushion platform", "EGO foam"],
        useCases: ["daily-trainer", "long-run", "walking"],
        notes: "Altra's flagship neutral road trainer. Zero drop + wide foot-shaped toe box define Altra's identity. Requires adaptation period for heel-strike runners. EGO foam delivers good energy return.",
      },
    ],
  },

  {
    id: "altra-paradigm",
    brand: "Altra",
    model: "Paradigm",
    category: "stability",
    cushion: "max",
    variants: [
      {
        version: "7",
        year: 2024,
        spec: { heelStack: 33, forefootStack: 33, drop: 0, weightGrams: 296, msrp: 165 },
        foam: "Altra EGO + GuideForm medial",
        plate: { present: false },
        surfaces: ["road"],
        rocker: false,
        features: ["zero drop with GuideForm stability", "foot-shaped toe box", "max cushion for zero-drop"],
        useCases: ["daily-trainer", "long-run", "walking"],
        notes: "Only max-cushion stability zero-drop trainer in the market. GuideForm medial support is gentler than traditional posts. Unique niche for overpronators wanting zero-drop.",
      },
    ],
  },

  {
    id: "altra-fwd-via",
    brand: "Altra",
    model: "FWD VIA",
    category: "neutral",
    cushion: "high",
    variants: [
      {
        version: "2",
        year: 2025,
        spec: { heelStack: 32, forefootStack: 32, drop: 0, weightGrams: 262, msrp: 165 },
        foam: "Altra EGO PRO",
        plate: { present: false },
        surfaces: ["road"],
        rocker: true,
        features: ["Altra EGO PRO foam (higher grade)", "rocker geometry", "zero drop", "wider base"],
        useCases: ["daily-trainer", "tempo", "long-run"],
        notes: "RTINGS listed as a notable shoe 2026. Altra's most performance-oriented zero-drop trainer. EGO PRO foam is more responsive than standard EGO. Rocker promotes efficient roll-off.",
      },
    ],
  },

  {
    id: "altra-escalante",
    brand: "Altra",
    model: "Escalante",
    category: "neutral",
    cushion: "moderate",
    variants: [
      {
        version: "4",
        year: 2024,
        spec: { heelStack: 24, forefootStack: 24, drop: 0, weightGrams: 244, msrp: 140 },
        foam: "Altra EGO",
        plate: { present: false },
        surfaces: ["road"],
        rocker: false,
        features: ["zero drop", "knit upper", "lower stack than Torin", "lightweight"],
        useCases: ["daily-trainer", "tempo"],
        notes: "Altra's lightweight zero-drop road trainer. Less stack than Torin — better ground feel. Good for experienced zero-drop runners wanting a faster feel.",
      },
    ],
  },

  {
    id: "altra-olympus",
    brand: "Altra",
    model: "Olympus",
    category: "neutral",
    cushion: "max",
    variants: [
      {
        version: "6",
        year: 2024,
        spec: { heelStack: 33, forefootStack: 33, drop: 0, weightGrams: 302, msrp: 165 },
        foam: "Altra EGO MAX",
        plate: { present: false },
        surfaces: ["trail"],
        rocker: false,
        features: ["zero drop trail", "Vibram outsole", "max cushion for trail", "foot-shaped toe box"],
        useCases: ["trail"],
        notes: "Altra's max-cushion zero-drop trail shoe. Vibram outsole and EGO MAX foam for long trail runs. Unique zero-drop trail option in the market.",
      },
    ],
  },
];
