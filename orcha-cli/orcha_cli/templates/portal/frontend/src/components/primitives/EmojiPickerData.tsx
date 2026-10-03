/**
 * D14 — the emoji set for the project-icon picker. The portal ships no emoji
 * dependency, so this is a curated subset (~400) of Unicode emoji ≤ 13.0 (they
 * render on every current macOS / Windows / Linux emoji font), grouped like the
 * CLDR groups, each with its CLDR short name + a few search words. Any other
 * emoji can still be typed or pasted (or picked with the OS picker —
 * ⌃⌘Space / Win+.) into the search field and used directly.
 */
export interface EmojiEntry { emoji: string; name: string }
export interface EmojiGroup { slug: string; label: string; emojis: EmojiEntry[] }

// "emoji name words|emoji name words|…" per group (compact, parsed once).
const RAW: [string, string, string][] = [
  ["smileys", "Smileys", "😀 grinning face happy smile|😃 grinning face big eyes|😄 grinning smiling eyes|😁 beaming grin|😆 laughing squinting|😅 sweat smile|😂 tears of joy laugh|🙂 slightly smiling|😉 winking|😊 smiling blush|😇 halo angel|🥰 hearts love|😍 heart eyes love|🤩 star struck|😘 kiss|😋 yum tasty|😛 tongue|🤪 zany crazy|🤑 money mouth|🤗 hugging|🤔 thinking|🤐 zipper mouth|😐 neutral|😏 smirking|😴 sleeping|😌 relieved|🤓 nerd glasses|😎 sunglasses cool|🥳 party celebrate|🤠 cowboy|😕 confused|😮 open mouth surprised|😲 astonished|😳 flushed|🥺 pleading|😢 crying sad|😭 sobbing|😱 scream fear|😤 steam triumph|😡 pouting angry|🤯 exploding head mind blown|😈 devil smiling horns|👻 ghost|💀 skull|👽 alien|👾 alien monster space invader game|🤖 robot bot ai|💩 poo|🎃 jack o lantern pumpkin|😺 cat smiling|🙈 see no evil monkey"],
  ["people", "People", "👋 waving hand hello|👍 thumbs up ok|👎 thumbs down|👏 clapping|🙌 raising hands|🙏 folded hands please thanks|💪 flexed biceps strong|✌️ victory peace|🤞 crossed fingers luck|👌 ok hand|🤝 handshake deal|✍️ writing hand|👀 eyes look|🧠 brain mind|👶 baby|🧑 person|👩 woman|👨 man|🧑‍💻 technologist developer coder|🧑‍🔬 scientist|🧑‍🎨 artist|🧑‍🚀 astronaut|🧑‍🏫 teacher|🧑‍⚕️ health worker doctor|🧑‍🍳 cook chef|🧑‍🔧 mechanic|🧑‍🌾 farmer|🦸 superhero|🧙 mage wizard|🧛 vampire|🧜 merperson|🧚 fairy|🥷 ninja|👑 crown king|🎓 graduation cap|🗣️ speaking head|👥 busts people team|🫂 people hugging|🏃 running|🚶 walking"],
  ["nature", "Nature", "🐶 dog|🐱 cat|🐭 mouse|🦊 fox|🐻 bear|🐼 panda|🐨 koala|🐯 tiger|🦁 lion|🐮 cow|🐷 pig|🐸 frog|🐵 monkey|🐔 chicken|🐧 penguin|🐦 bird|🦅 eagle|🦉 owl|🦇 bat|🐺 wolf|🐴 horse|🦄 unicorn|🐝 bee honeybee|🐛 bug|🦋 butterfly|🐌 snail|🐞 lady beetle ladybug|🐢 turtle|🐍 snake python|🦎 lizard|🦖 t-rex dinosaur|🐙 octopus|🦑 squid|🦀 crab|🐠 tropical fish|🐟 fish|🐬 dolphin|🐳 whale spouting|🐋 whale|🦈 shark|🐊 crocodile|🐘 elephant|🦒 giraffe|🦓 zebra|🦘 kangaroo|🐿️ chipmunk|🦔 hedgehog|🌵 cactus|🎄 christmas tree|🌲 evergreen tree|🌳 deciduous tree|🌴 palm tree|🌱 seedling sprout|🌿 herb|🍀 four leaf clover luck|🍁 maple leaf|🍂 fallen leaf|🍄 mushroom|🌸 cherry blossom flower|🌹 rose|🌻 sunflower|🌼 blossom|🌷 tulip|🌍 globe europe africa earth|🌎 globe americas|🌏 globe asia|🌙 crescent moon|⭐ star|🌟 glowing star|✨ sparkles|⚡ high voltage lightning|🔥 fire|🌈 rainbow|☀️ sun|⛅ cloud sun|☁️ cloud|❄️ snowflake|🌊 water wave ocean|💧 droplet water"],
  ["food", "Food", "🍏 green apple|🍎 red apple|🍐 pear|🍊 tangerine orange|🍋 lemon|🍌 banana|🍉 watermelon|🍇 grapes|🍓 strawberry|🫐 blueberries|🍒 cherries|🍑 peach|🥭 mango|🍍 pineapple|🥥 coconut|🥝 kiwi|🍅 tomato|🥑 avocado|🥦 broccoli|🌶️ hot pepper chili|🌽 corn|🥕 carrot|🥐 croissant|🍞 bread|🧀 cheese|🥚 egg|🥞 pancakes|🥓 bacon|🍔 hamburger burger|🍟 french fries|🍕 pizza|🌭 hot dog|🌮 taco|🌯 burrito|🥗 salad|🍝 spaghetti pasta|🍜 ramen noodles|🍣 sushi|🍱 bento|🥟 dumpling|🍩 doughnut donut|🍪 cookie|🎂 birthday cake|🍰 shortcake|🧁 cupcake|🍫 chocolate|🍬 candy|🍭 lollipop|🍯 honey pot|🍿 popcorn|☕ hot beverage coffee|🍵 tea|🧋 bubble tea|🍺 beer|🍷 wine|🍸 cocktail|🥤 cup straw soda|🧊 ice"],
  ["travel", "Travel", "🚗 car automobile|🚕 taxi|🚌 bus|🏎️ racing car|🚓 police car|🚑 ambulance|🚒 fire engine|🚚 delivery truck|🚜 tractor|🚲 bicycle bike|🛴 kick scooter|🏍️ motorcycle|🚂 locomotive train|🚆 train|🚇 metro subway|🚊 tram|✈️ airplane plane flight|🛫 departure|🚀 rocket launch|🛸 flying saucer ufo|🚁 helicopter|⛵ sailboat|🚤 speedboat|🚢 ship|⚓ anchor|🛰️ satellite|🗺️ world map|🧭 compass|🏔️ snow mountain|⛰️ mountain|🌋 volcano|🏕️ camping|🏖️ beach|🏝️ island|🏜️ desert|🏠 house home|🏡 house garden|🏢 office building|🏭 factory|🏥 hospital|🏦 bank|🏫 school|🏰 castle|🗼 tower|🗽 statue of liberty|⛩️ shrine|🌉 bridge night|🌃 night stars city|🎡 ferris wheel|🎢 roller coaster|⛽ fuel pump gas|🚦 traffic light|🚧 construction"],
  ["activities", "Activities", "⚽ soccer football|🏀 basketball|🏈 american football|⚾ baseball|🎾 tennis|🏐 volleyball|🏉 rugby|🎱 pool 8 ball|🏓 ping pong|🏸 badminton|🥊 boxing glove|🥋 martial arts|⛳ golf flag|⛸️ ice skate|🎿 skis|🏂 snowboarder|🏄 surfing|🏊 swimming|🚴 biking cyclist|🏆 trophy award winner|🥇 gold medal first|🏅 sports medal|🎖️ military medal|🎯 direct hit target bullseye goal|🎮 video game controller|🕹️ joystick arcade|🎲 game die dice|🧩 puzzle piece|♟️ chess pawn|🎨 artist palette art|🎭 performing arts theater|🎬 clapper board film movie|🎤 microphone|🎧 headphone|🎼 musical score|🎹 keyboard piano|🥁 drum|🎸 guitar|🎺 trumpet|🎻 violin|🎉 party popper tada celebrate|🎊 confetti ball|🎈 balloon|🎁 gift present|🎀 ribbon|🎟️ ticket|🪁 kite|🎳 bowling"],
  ["objects", "Objects", "💻 laptop computer|🖥️ desktop computer|⌨️ keyboard|🖱️ mouse computer|🖨️ printer|📱 mobile phone smartphone|☎️ telephone|📞 telephone receiver|📟 pager|📠 fax|🔋 battery|🔌 electric plug|💡 light bulb idea|🔦 flashlight|🕯️ candle|📷 camera photo|📹 video camera|🎥 movie camera|📺 television tv|📻 radio|🎙️ studio microphone podcast|⏰ alarm clock|⌛ hourglass|⏱️ stopwatch|🧭 compass|📡 satellite antenna|🔭 telescope|🔬 microscope|🧪 test tube lab|🧫 petri dish|🧬 dna|⚗️ alembic chemistry|💊 pill|🩺 stethoscope|🔧 wrench tool|🔨 hammer|🛠️ hammer and wrench tools|⚙️ gear settings|🔩 nut and bolt|⛓️ chains|🧰 toolbox|🧲 magnet|🪛 screwdriver|🔑 key|🗝️ old key|🔒 locked lock security|🔓 unlocked|🛡️ shield security|🗡️ dagger|⚔️ crossed swords|🏹 bow and arrow|💣 bomb|📦 package box|📫 mailbox|✉️ envelope mail|📧 e-mail|📨 incoming envelope|📝 memo note|📄 page document|📃 page with curl|📑 bookmark tabs|📊 bar chart|📈 chart increasing growth|📉 chart decreasing|🗂️ card index dividers|📁 file folder|📂 open file folder|🗃️ card file box|🗄️ file cabinet|📋 clipboard|📌 pushpin|📎 paperclip|✂️ scissors|🖊️ pen|✏️ pencil|🖌️ paintbrush|🖍️ crayon|📚 books library|📖 open book|📓 notebook|📒 ledger|📕 closed book|🔖 bookmark|🏷️ label tag|💰 money bag|💳 credit card|💎 gem stone diamond|⚖️ balance scale law|🛒 shopping cart|🛍️ shopping bags|🧾 receipt|🪙 coin|💵 dollar banknote|🏦 bank|🗑️ wastebasket trash|🧹 broom|🧺 basket|🧸 teddy bear|🪴 potted plant|🛋️ couch|🚪 door|🪞 mirror|🔮 crystal ball|🧿 nazar amulet|📿 prayer beads|🎩 top hat|👓 glasses|🕶️ sunglasses|🎒 backpack|👜 handbag|💼 briefcase work|🧳 luggage travel|☂️ umbrella|🪄 magic wand"],
  ["symbols", "Symbols", "❤️ red heart love|🧡 orange heart|💛 yellow heart|💚 green heart|💙 blue heart|💜 purple heart|🖤 black heart|🤍 white heart|🤎 brown heart|💔 broken heart|💯 hundred points|💢 anger|💥 collision boom|💫 dizzy|💬 speech balloon chat|💭 thought balloon|🗯️ anger bubble|💤 zzz sleep|✅ check mark button done|☑️ check box|✔️ check mark|❌ cross mark|❎ cross button|➕ plus|➖ minus|➗ divide|✖️ multiply|❓ question mark|❗ exclamation mark|‼️ double exclamation|⚠️ warning|🚫 prohibited|⛔ no entry|🔞 no one under eighteen|♻️ recycling|⚛️ atom|🕉️ om|☯️ yin yang|☮️ peace symbol|♾️ infinity|🔱 trident|⚜️ fleur de lis|🔰 beginner|⭕ hollow red circle|🔴 red circle|🟠 orange circle|🟡 yellow circle|🟢 green circle|🔵 blue circle|🟣 purple circle|⚫ black circle|⚪ white circle|🟥 red square|🟧 orange square|🟨 yellow square|🟩 green square|🟦 blue square|🟪 purple square|⬛ black square|⬜ white square|🔶 orange diamond|🔷 blue diamond|🔺 red triangle up|🔻 red triangle down|💠 diamond dot|🔘 radio button|🔳 square button|▶️ play button|⏸️ pause button|⏹️ stop button|⏺️ record button|⏩ fast forward|🔁 repeat|🔀 shuffle|🔃 clockwise arrows|🔄 counterclockwise arrows sync|⬆️ up arrow|➡️ right arrow|⬇️ down arrow|⬅️ left arrow|↗️ up right arrow|🔝 top arrow|🆕 new button|🆗 ok button|🆒 cool button|🆓 free button|🆙 up button|🔤 abc latin letters|🔢 input numbers|#️⃣ keycap number sign hash|*️⃣ keycap asterisk|0️⃣ keycap 0 zero|1️⃣ keycap 1 one|2️⃣ keycap 2 two|3️⃣ keycap 3 three|🔣 input symbols|ℹ️ information|Ⓜ️ circled m|🅰️ a button|🅱️ b button|🆎 ab button|🆘 sos|📶 antenna bars signal|🔔 bell|🔕 bell slash mute|📣 megaphone|📢 loudspeaker|🎵 musical note|🎶 musical notes|🏁 chequered flag finish|🚩 triangular flag|🏳️ white flag|🏴 black flag|🏳️‍🌈 rainbow flag|🏴‍☠️ pirate flag"],
  ["flags", "Flags", "🇺🇸 flag united states usa|🇬🇧 flag united kingdom uk|🇨🇦 flag canada|🇲🇽 flag mexico|🇧🇷 flag brazil|🇦🇷 flag argentina|🇫🇷 flag france|🇩🇪 flag germany|🇮🇹 flag italy|🇪🇸 flag spain|🇵🇹 flag portugal|🇳🇱 flag netherlands|🇧🇪 flag belgium|🇨🇭 flag switzerland|🇸🇪 flag sweden|🇳🇴 flag norway|🇩🇰 flag denmark|🇫🇮 flag finland|🇮🇪 flag ireland|🇵🇱 flag poland|🇺🇦 flag ukraine|🇹🇷 flag turkey|🇬🇷 flag greece|🇪🇬 flag egypt|🇰🇪 flag kenya|🇸🇴 flag somalia|🇪🇹 flag ethiopia|🇳🇬 flag nigeria|🇿🇦 flag south africa|🇸🇦 flag saudi arabia|🇦🇪 flag united arab emirates|🇮🇳 flag india|🇵🇰 flag pakistan|🇨🇳 flag china|🇯🇵 flag japan|🇰🇷 flag south korea|🇸🇬 flag singapore|🇮🇩 flag indonesia|🇦🇺 flag australia|🇳🇿 flag new zealand|🇪🇺 flag european union"],
];

let groups: EmojiGroup[] | null = null;

/** The picker groups (parsed once). */
export function emojiGroups(): EmojiGroup[] {
  if (groups) return groups;
  groups = RAW.map(([slug, label, list]) => ({
    slug, label,
    emojis: list.split("|").map((s) => {
      const i = s.indexOf(" ");
      return { emoji: s.slice(0, i), name: s.slice(i + 1) };
    }),
  }));
  return groups;
}

/** Every query word must prefix a word of the emoji's name or group ("red hea" → ❤️). */
export function searchEmoji(query: string, limit = 160): EmojiEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const out: EmojiEntry[] = [];
  const seen = new Set<string>();
  for (const g of emojiGroups()) {
    for (const e of g.emojis) {
      if (seen.has(e.emoji)) continue;
      const hay = `${e.name} ${g.label}`.toLowerCase().split(/[\s:,_-]+/);
      if (words.every((w) => hay.some((h) => h.startsWith(w)))) {
        seen.add(e.emoji);
        out.push(e);
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}
