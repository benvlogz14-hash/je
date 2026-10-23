/** Caption and banner fonts, grouped for the picker. All are bundled (free licences) except the System group. */
export const FONT_GROUPS = [
  ['Bold YouTube', ['Luckiest Guy', 'Bangers', 'Titan One', 'Lilita One', 'Bowlby One', 'Bowlby One SC', 'Bungee', 'Sigmar One', 'Rammetto One', 'Dela Gothic One', 'Archivo Black', 'Paytone One', 'Passion One', 'Poppins', 'Kanit', 'Montserrat', 'Anton', 'Bebas Neue', 'Staatliches', 'Barlow Condensed', 'Titillium Web', 'Russo One', 'Changa One', 'Knewave', 'Chewy']],
  ['Horror and creepy', ['Creepster', 'Nosifer', 'Eater', 'Metal Mania', 'Frijole', 'Rubik Wet Paint', 'Special Elite', 'Rubik Glitch']],
  ['Handwritten and marker', ['Permanent Marker', 'Rock Salt', 'Caveat Brush', 'Gloria Hallelujah', 'Kalam', 'Shrikhand', 'Pacifico', 'Lobster']],
  ['Retro, gaming and sci-fi', ['Press Start 2P', 'Silkscreen', 'VT323', 'Audiowide', 'Monoton', 'Black Ops One', 'Righteous', 'Racing Sans One', 'Bungee Shade', 'Rubik Mono One']],
  ['Classic and serif', ['Abril Fatface', 'Alfa Slab One', 'DM Serif Display', 'Playfair Display SC', 'Gravitas One']],
  ['On this PC', ['Arial Black', 'Impact', 'Arial', 'Verdana', 'Georgia', 'Trebuchet MS', 'Comic Sans MS']],
];
export const FONTS = FONT_GROUPS.flatMap(([, list]) => list);
/** Fonts that come in a real bold/black weight; the rest are drawn at their own weight (no fake bold). */
export const HEAVY = new Set(['Montserrat', 'Poppins', 'Kanit', 'Barlow Condensed', 'Titillium Web', 'Passion One', 'Playfair Display SC', 'Kalam', 'Silkscreen', 'Arial', 'Verdana', 'Georgia', 'Trebuchet MS', 'Comic Sans MS']);
export const weightOf = (f) => (HEAVY.has(f) ? 800 : 400);
