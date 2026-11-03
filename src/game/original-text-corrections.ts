import type { OriginalDataArray } from './original-data-arrays.ts'

/**
 * Spelling, translation and consistency corrections to Language.nmo's text
 * tables (`language`: the menu text; `all_keys`: the key names), approved by the
 * maintainer. Each one pins the original cell by its FNV-1a hash (UTF-16 code
 * units), so the original text is not redistributed and another install's
 * different text fails loudly instead of being rewritten. Only display text
 * changes: the graphs read these tables by row index or the DIK column.
 */
export interface OriginalTextCorrection {
  table: 'language' | 'all_keys'
  row: number
  column: 'german' | 'english' | 'spanish' | 'italian' | 'french'
  /** FNV-1a 32 of the original cell. */
  original: string
  corrected: string
}

export const ORIGINAL_TEXT_CORRECTIONS: readonly OriginalTextCorrection[] = [
  { table: 'language', row: 0, column: 'spanish', original: '49e53544', corrected: "Iniciar" },
  { table: 'language', row: 1, column: 'spanish', original: '8694d4ed', corrected: "Récords" },
  { table: 'language', row: 1, column: 'french', original: '59f287db', corrected: "Classement" },
  { table: 'language', row: 3, column: 'spanish', original: 'e8438e2a', corrected: "Salir" },
  { table: 'language', row: 3, column: 'italian', original: '18e305a6', corrected: "Esci" },
  { table: 'language', row: 4, column: 'spanish', original: '0f9ade75', corrected: "Créditos" },
  { table: 'language', row: 15, column: 'spanish', original: 'de832c6a', corrected: "Atrás" },
  { table: 'language', row: 15, column: 'italian', original: '8f3b6f35', corrected: "  Torna" },
  { table: 'language', row: 16, column: 'spanish', original: '50e20016', corrected: "Continuar" },
  { table: 'language', row: 17, column: 'german', original: '0441388f', corrected: "  Level-Neustart" },
  { table: 'language', row: 17, column: 'spanish', original: '1ce854c5', corrected: "Reiniciar nivel" },
  { table: 'language', row: 18, column: 'german', original: '9d0df604', corrected: "  Level beenden" },
  { table: 'language', row: 18, column: 'spanish', original: '8471dcd9', corrected: "Salir del nivel" },
  { table: 'language', row: 19, column: 'german', original: '65e485cf', corrected: "OK" },
  { table: 'language', row: 21, column: 'spanish', original: '7cdfa037', corrected: "¿Quiere reiniciar el nivel?" },
  { table: 'language', row: 21, column: 'french', original: '1236b8a5', corrected: "Voulez-vous redémarrer le niveau ?" },
  { table: 'language', row: 22, column: 'spanish', original: '72d886b5', corrected: "¿Quiere salir del nivel?" },
  { table: 'language', row: 22, column: 'french', original: 'b367d26a', corrected: "Voulez-vous quitter le niveau ?" },
  { table: 'language', row: 23, column: 'spanish', original: 'b438ebb1', corrected: "¿Quiere salir del juego?" },
  { table: 'language', row: 23, column: 'french', original: '4e56a0c9', corrected: "Voulez-vous quitter le jeu ?" },
  { table: 'language', row: 24, column: 'spanish', original: '4fea4378', corrected: "Menú principal" },
  { table: 'language', row: 25, column: 'english', original: '4626ad2e', corrected: "Next Level" },
  { table: 'language', row: 27, column: 'german', original: '2c7ef845', corrected: " Neuer Highscore-Eintrag!" },
  { table: 'language', row: 27, column: 'spanish', original: '472583f8', corrected: "¡Nuevo récord!" },
  { table: 'language', row: 27, column: 'french', original: '49697fa0', corrected: "Entrez le nouveau score !" },
  { table: 'language', row: 29, column: 'spanish', original: '8a4f18c2', corrected: "Gráficos" },
  { table: 'language', row: 30, column: 'spanish', original: '8347bf3e', corrected: "Controles" },
  { table: 'language', row: 30, column: 'french', original: '2ecd9110', corrected: "Contrôles" },
  { table: 'language', row: 32, column: 'spanish', original: '14fe0865', corrected: "Resolución" },
  { table: 'language', row: 32, column: 'italian', original: '1d813887', corrected: "Risoluzione video" },
  { table: 'language', row: 32, column: 'french', original: '836cf483', corrected: "Résolution" },
  { table: 'language', row: 33, column: 'german', original: '94d4efc2', corrected: "  Vertikal-Sync?" },
  { table: 'language', row: 33, column: 'english', original: '94d4efc2', corrected: "  Sync to Screen?" },
  { table: 'language', row: 33, column: 'spanish', original: '2903577a', corrected: "¿Sinc. vertical?" },
  { table: 'language', row: 33, column: 'italian', original: '2903577a', corrected: "Sinc. verticale?" },
  { table: 'language', row: 33, column: 'french', original: '2903577a', corrected: "Sync. verticale ?" },
  { table: 'language', row: 34, column: 'italian', original: '40025f11', corrected: "Sì" },
  { table: 'language', row: 36, column: 'spanish', original: 'aa746bfb', corrected: "¿Nubes?" },
  { table: 'language', row: 36, column: 'french', original: 'a9a55fd1', corrected: "Nuages ?" },
  { table: 'language', row: 41, column: 'spanish', original: 'db46b33b', corrected: "Vista" },
  { table: 'language', row: 43, column: 'spanish', original: '603e3317', corrected: "  ¿Invertir la rotación?" },
  { table: 'language', row: 43, column: 'french', original: 'a4ede459', corrected: "  Inverser la rotation ?" },
  { table: 'language', row: 44, column: 'italian', original: 'ad69a31d', corrected: "Volume musica" },
  { table: 'language', row: 45, column: 'german', original: '53eabf70', corrected: "Levelbonus:" },
  { table: 'language', row: 45, column: 'spanish', original: 'ed4c283e', corrected: "Bonus de nivel:" },
  { table: 'language', row: 45, column: 'french', original: 'a42df57a', corrected: "Bonus :" },
  { table: 'language', row: 46, column: 'german', original: '7e9bf78c', corrected: "Zeitbonus:" },
  { table: 'language', row: 46, column: 'spanish', original: 'b6c90615', corrected: "Puntos de tiempo:" },
  { table: 'language', row: 46, column: 'italian', original: '51401ac1', corrected: "Punti tempo:" },
  { table: 'language', row: 46, column: 'french', original: 'b2cc1521', corrected: "Points temps :" },
  { table: 'language', row: 47, column: 'german', original: '38ce241d', corrected: "Extraleben:" },
  { table: 'language', row: 47, column: 'spanish', original: '5ef0a1d9', corrected: "Vidas extra:" },
  { table: 'language', row: 47, column: 'italian', original: 'd453c02e', corrected: "Vite extra:" },
  { table: 'language', row: 47, column: 'french', original: 'c6464a88', corrected: "Vies bonus :" },
  { table: 'language', row: 48, column: 'spanish', original: 'd0f1aeba', corrected: "Puntuación total:" },
  { table: 'language', row: 48, column: 'french', original: '4e939377', corrected: "Score total :" },
  { table: 'language', row: 51, column: 'spanish', original: '2240ef4b', corrected: "Récords\nNivel " },
  { table: 'language', row: 51, column: 'italian', original: '62630a29', corrected: "Record\nLivello " },
  { table: 'all_keys', row: 12, column: 'german', original: '025a3509', corrected: "Rücktaste" },
  { table: 'all_keys', row: 12, column: 'english', original: '5bb421a2', corrected: "backspace" },
  { table: 'all_keys', row: 12, column: 'spanish', original: '5bb421a2', corrected: "retroceso" },
  { table: 'all_keys', row: 22, column: 'italian', original: 'd50c118f', corrected: "O" },
  { table: 'all_keys', row: 39, column: 'spanish', original: '54019347', corrected: "mayús" },
  { table: 'all_keys', row: 39, column: 'italian', original: '54019347', corrected: "maiusc" },
  { table: 'all_keys', row: 51, column: 'spanish', original: 'f6ab7cdf', corrected: "mayús dcha." },
  { table: 'all_keys', row: 51, column: 'italian', original: '0c0a171e', corrected: "maiusc destro" },
  { table: 'all_keys', row: 52, column: 'english', original: '43f6e25d', corrected: "alt" },
  { table: 'all_keys', row: 53, column: 'german', original: 'aa7e1a1d', corrected: "Leertaste" },
  { table: 'all_keys', row: 53, column: 'spanish', original: '54c9f1f5', corrected: "espacio" },
  { table: 'all_keys', row: 68, column: 'french', original: '77b77ead', corrected: "haut" },
  { table: 'all_keys', row: 69, column: 'italian', original: '34b48765', corrected: "Giù" },
  { table: 'all_keys', row: 69, column: 'french', original: 'd6d48ef3', corrected: "bas" },
]

/**
 * Corrected tutorial chapters (`Text\Tutorial<n>.txt`, `*`-separated, after the
 * Windows-1252 decode and CRLF -> LF): spelling, grammar, apostrophes, the local
 * key names and French spacing, keeping each chapter's line structure and
 * length so the tutorial box lays out as before. Pinned by hash like the tables.
 */
export interface OriginalTutorialCorrection {
  file: string
  chapter: number
  original: string
  corrected: string
}

export const ORIGINAL_TUTORIAL_CORRECTIONS: readonly OriginalTutorialCorrection[] = [
  { file: 'tutorial1.txt', chapter: 1, original: 'f9ea8bb4', corrected: "Drehen der Ansicht:\nHalten Sie die linke \"UMSCHALT\"-Taste (Shift) gedrückt und benutzen Sie dabei gleichzeitig die Pfeiltasten \"LINKS\" und \"RECHTS\", um die Ansicht in 90-Grad-Schritten zu drehen.\n\nWeiter mit \"EINGABE\" ...\n" },
  { file: 'tutorial1.txt', chapter: 2, original: 'b41dc289', corrected: "Anheben der Ansicht:\nUm eine bessere Übersicht zu bekommen, halten Sie die \"LEERTASTE\" gedrückt.\n\nWeiter mit \"EINGABE\" ...\n" },
  { file: 'tutorial1.txt', chapter: 4, original: '4b838ea9', corrected: "Extra-Leben:\nWenn Sie herunterfallen, wird Ihnen ein Leben abgezogen. Die verbleibenden Leben erkennen Sie an der Anzeige unten rechts.\nDurch das Aufsammeln eines Lebens-Extras können Sie ein weiteres Leben hinzugewinnen.\n\nWeiter mit \"EINGABE\" ...\n" },
  { file: 'tutorial1.txt', chapter: 6, original: '63f96cfa', corrected: "Die Steigung ist zu steil für einen Steinball!\nSuchen Sie nach einem Holz-Trafo und versuchen Sie es danach erneut.\nTipp: Drehen Sie gelegentlich Ihre Ansicht (\"UMSCHALT\" + \"RECHTS/LINKS\"), um sich besser zu orientieren. Rückwärtsrollen kann gefährlich sein!\nWeiter mit \"EINGABE\" ...\n" },
  { file: 'tutorial1.txt', chapter: 7, original: 'e3929616', corrected: "Punkte-Extra:\nAuf der linken Seite können Sie Ihren aktuellen Punktestand ablesen, der während des Spiels ständig abnimmt. Durch das Aufsammeln eines Punkte-Extras können Sie Ihren Punktestand erhöhen.\n\nWeiter mit \"EINGABE\" ...\n" },
  { file: 'tutorial1.txt', chapter: 8, original: 'cb2e09d5', corrected: "Checkpoints:\nDies ist ein Checkpoint, den Sie durchfahren müssen. Verlieren Sie während des Spiels ein Leben, so können Sie immer vom letzten durchfahrenen Checkpoint weiterspielen.\n\nWeiter mit \"EINGABE\" ...\n" },
  { file: 'tutorial1.txt', chapter: 9, original: 'a30ba32c', corrected: "Zum Abschluss:\nSollten Sie einmal nicht mehr weiterkommen, so können Sie in der HTML-Spielhilfe nachlesen. Die Spielhilfe mit Tipps und Hinweisen finden Sie über das Windows-Startmenü (nicht während des Spiels). \n\nBeenden der Einführung mit \"EINGABE\" ...\n" },
  { file: 'tutorial2.txt', chapter: 4, original: '110a1286', corrected: "Life Extra:\nIf you fall off the track, you lose one life. Your remaining lives are displayed at the bottom right of the screen. You receive an additional life by picking up a \"Life Extra\".\n\nContinue with \"RETURN\" ...\n" },
  { file: 'tutorial2.txt', chapter: 6, original: 'bf04d995', corrected: "This slope is too steep for a stone ball!\nLook for a wood transformer and try again. \nHint: Turn the view (SHIFT + RIGHT/LEFT) to get a better orientation. Rolling backwards can be dangerous!\n\nContinue with \"RETURN\" ...\n" },
  { file: 'tutorial2.txt', chapter: 7, original: '8e2d9243', corrected: "Point Extra:\nThe display on the left shows your current points, which are constantly decreasing during the game. You increase your score by picking up a Point Extra.\n\nContinue with \"RETURN\" ...\n" },
  { file: 'tutorial2.txt', chapter: 8, original: 'b8b47900', corrected: "Checkpoints:\nThis is the first checkpoint you have to pass.\nIf you lose a life during the game, you can continue the game from the last checkpoint.\n\nContinue with \"RETURN\" ...\n" },
  { file: 'tutorial3.txt', chapter: 0, original: 'd26070b9', corrected: "Introducción al juego:\nCon \"ESC\" puede pausar el juego en cualquier momento o salir de él. Puede continuar la introducción con la tecla \"Intro\" (Return) o terminarla con la tecla \"Q\".\n" },
  { file: 'tutorial3.txt', chapter: 1, original: '10e256b3', corrected: "Girar la vista:\nMantenga pulsada la tecla \"Mayús\" (Shift) izquierda y utilice a la vez las teclas de flecha \"izquierda\" y \"derecha\" para girar la vista en pasos de 90 grados.\n\nContinuar con \"Intro\" ...\n" },
  { file: 'tutorial3.txt', chapter: 2, original: '64e9f019', corrected: "Subir la vista:\nPara tener una mejor vista general, mantenga pulsada la \"barra espaciadora\".\n\nContinuar con \"Intro\" ...\n" },
  { file: 'tutorial3.txt', chapter: 3, original: '0df6588e', corrected: "Navegación: \nGire ahora la vista hasta que el camino de las dos torres esté delante de usted.\nCon las teclas de flecha puede guiar la bola \"adelante\", \"atrás\", \"a la derecha\" y \"a la izquierda\".\n\n¡Siga el camino!\n" },
  { file: 'tutorial3.txt', chapter: 4, original: '3ddbe450', corrected: "Vida extra: \nSi se cae, pierde una vida. Las vidas restantes se muestran en el indicador de abajo a la derecha. \nRecogiendo una vida extra puede ganar una vida adicional.\n\nContinuar con \"Intro\" ...\n" },
  { file: 'tutorial3.txt', chapter: 5, original: '9dbf3072', corrected: "Trafos: \nCon ayuda de los llamados transformadores puede cambiar el material de su bola. El tipo de transformador se reconoce por el material del área del trafo. Este es un transformador de piedra. \n\nContinuar con \"Intro\" ...\n" },
  { file: 'tutorial3.txt', chapter: 6, original: '9e549f28', corrected: "La subida es demasiado empinada para una bola de piedra: busque un trafo de madera y después inténtelo de nuevo.\nConsejo: gire de vez en cuando la vista (teclas \"Mayús\" y \"derecha/izquierda\") para orientarse mejor. Rodar hacia atrás puede ser peligroso.   Continuar con \"Intro\" ...\n" },
  { file: 'tutorial3.txt', chapter: 7, original: '6d49a447', corrected: "Punto extra:\nEn el lado izquierdo puede ver su puntuación actual, que va disminuyendo durante el juego. Recogiendo un punto extra puede aumentar su puntuación. \n\nContinuar con \"Intro\" ...\n" },
  { file: 'tutorial3.txt', chapter: 8, original: 'd20cab6c', corrected: "Checkpoints (puntos de control):\nEste es un checkpoint por el que tiene que pasar. Si pierde una vida durante el juego, siempre puede seguir jugando desde el último checkpoint por el que haya pasado. \n\nContinuar con \"Intro\" ...\n" },
  { file: 'tutorial3.txt', chapter: 9, original: 'e78f6b65', corrected: "Al final: si ya no puede avanzar, puede consultar el manual HTML del juego. El manual, con consejos e indicaciones, se encuentra en el menú Inicio de Windows (no durante el juego).\n\nTermine la introducción con \"Intro\" ...\n\n" },
  { file: 'tutorial4.txt', chapter: 0, original: '5cd0ec1c', corrected: "Introduzione al gioco:\nPremere \"ESC\" per fermare o abbandonare il gioco in ogni momento.\nPremere \"Invio\" per continuare l'introduzione o \"Q\" per fermarla.\n" },
  { file: 'tutorial4.txt', chapter: 2, original: '5052c05c', corrected: "Alzare la visuale:\nPer ottenere una migliore vista d'insieme premete la \"Barra spaziatrice\".\n\nAvanti con \"Invio\" ...\n" },
  { file: 'tutorial4.txt', chapter: 4, original: '559ec1bf', corrected: "Vite extra:\nSe cadete giù perdete una vita. Le vite rimanenti sono segnalate dall'indicatore in basso a destra.\nRaccogliendo una Vita extra guadagnate automaticamente una vita.\n\nAvanti con \"Invio\" ...\n" },
  { file: 'tutorial4.txt', chapter: 5, original: 'cb3964e7', corrected: "Trasfo:\nTramite i cosiddetti \"Trasformatori\" potete cambiare il materiale della palla. Il tipo di trasformazione si riconosce dal materiale del campo del Trasfo. Questo è un Trasfo di pietra.\n\nAvanti con \"Invio\" ...\n" },
  { file: 'tutorial4.txt', chapter: 6, original: '8e24f5c6', corrected: "La salita è troppo ripida per una palla di pietra! Cercate un Trasfo di legno e riprovate.\nSugg.: ruotate di tanto in tanto la visuale (\"Shift\" + \"Destra/Sinistra\") per orientarvi meglio. Attenzione: rotolare all'indietro può essere pericoloso!\nAvanti con \"Invio\" ...\n" },
  { file: 'tutorial4.txt', chapter: 7, original: '22adfca0', corrected: "Punti extra:\nSul lato sinistro potete leggere il vostro punteggio attuale, che diminuisce costantemente durante il gioco. Raccogliendo i Punti extra avete la possibilità di aumentare il vostro punteggio.\n\nAvanti con \"Invio\" ...\n" },
  { file: 'tutorial4.txt', chapter: 8, original: '7dbabcf0', corrected: "Checkpoint:\nQuesto è un checkpoint e dovete attraversarlo. Se, mentre giocate, perdete una vita, potete continuare il gioco dall'ultimo checkpoint attraversato.\n\nAvanti con \"Invio\" ...\n" },
  { file: 'tutorial4.txt', chapter: 9, original: '925ba005', corrected: "Per concludere:\nSe non doveste più riuscire ad andare avanti, potete consultare la guida in linea HTML. La guida con suggerimenti e indicazioni si trova nel menu \nStart di Windows (non durante il gioco).\n\nPer concludere l'introduzione premere \"Invio\" ..." },
  { file: 'tutorial5.txt', chapter: 0, original: 'c78ec69e', corrected: "Initiation au jeu :\nAvec la touche \"ESC\", vous pouvez à tout moment interrompre ou quitter le jeu.\nAppuyez sur la touche \"Entrée\" pour poursuivre l'initiation ou sur la touche \"Q\" pour la quitter.\n" },
  { file: 'tutorial5.txt', chapter: 1, original: '90c57ae5', corrected: "Rotation de la caméra :\nMaintenez la touche \"Maj\" de gauche enfoncée et utilisez les flèches de direction gauche ou droite afin de faire pivoter la caméra par pas de 90 degrés.\n\nContinuer avec \"Entrée\" ...\n" },
  { file: 'tutorial5.txt', chapter: 2, original: '220d6007', corrected: "Élévation de la caméra :\nPour obtenir une meilleure vue d'ensemble, maintenez la touche \"Espace\" enfoncée. \n\nContinuer avec \"Entrée\" ...\n" },
  { file: 'tutorial5.txt', chapter: 3, original: '864ac473', corrected: "Contrôle :\nFaites pivoter la vue de façon à ce que le chemin et les deux tours se trouvent devant vous.\nÀ l'aide des flèches de direction, vous pouvez contrôler le déplacement de la balle vers l'avant, l'arrière, la gauche ou la droite. Suivez le chemin !\n" },
  { file: 'tutorial5.txt', chapter: 4, original: 'a2502fa0', corrected: "\"Vies supplémentaires\" :\nUne chute dans le vide entraîne la perte d'une vie. Le nombre de vies restantes est indiqué en bas à droite de l'écran.\nRamassez les \"vies supplémentaires\" afin d'obtenir une vie de plus. \n\nContinuer avec \"Entrée\" ...\n" },
  { file: 'tutorial5.txt', chapter: 5, original: '097a8072', corrected: "Transmutateurs :\nÀ l'aide des transmutateurs, vous pouvez modifier la structure de votre balle. Le type de transmutation est indiqué par le matériau représenté dans le champ du transmutateur. Ceci est un transmutateur \"pierre\".\n\nContinuer avec \"Entrée\" ...\n" },
  { file: 'tutorial5.txt', chapter: 6, original: 'dfd8fa6a', corrected: "La pente est trop raide pour une balle en pierre ! Recherchez un transmutateur \"bois\" et essayez à nouveau.\nConseil : faites pivoter l'angle de vue (touches \"Maj\" + flèche droite ou gauche) afin de mieux vous orienter. Reculer peut s'avérer dangereux !\nContinuer avec \"Entrée\" ...\n" },
  { file: 'tutorial5.txt', chapter: 7, original: '643638c4', corrected: "Points supplémentaires :\nSur le côté gauche de l'écran, vous pouvez lire votre score actuel. Ramassez les points supplémentaires pour augmenter votre score.\n\nContinuer avec \"Entrée\" ...\n" },
  { file: 'tutorial5.txt', chapter: 8, original: 'c5dd3a4b', corrected: "Point de contrôle :\nCeci est un point de contrôle par lequel vous devez passer. Après une chute, vous reprendrez toujours avec une nouvelle vie à partir du dernier point de contrôle franchi.\n\nContinuer avec \"Entrée\" ...\n" },
  { file: 'tutorial5.txt', chapter: 9, original: '40ae9657', corrected: "Enfin :\nEn cas de difficulté pour progresser dans le jeu, référez-vous à l'aide que vous trouverez dans le menu Démarrer de Windows. Cette aide offre de nombreux conseils pour chaque niveau.\n\nQuittez l'initiation avec \"Entrée\" ...\n  " },
]

/** Apply the tutorial corrections to one file's text (lower-case `tutorial<n>.txt`). */
export function correctTutorialText(file: string, text: string): string {
  const corrections = ORIGINAL_TUTORIAL_CORRECTIONS.filter(correction => correction.file === file)
  if (!corrections.length) return text
  const chapters = text.split('*')
  for (const correction of corrections) {
    const chapter = chapters[correction.chapter]
    if (chapter === undefined || textHash(chapter) !== correction.original) throw new Error(`${file} chapter ${correction.chapter} is not the original text the correction was made for`)
    chapters[correction.chapter] = correction.corrected
  }
  return chapters.join('*')
}

export function textHash(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0
  return hash.toString(16).padStart(8, '0')
}

/** Apply the corrections in place; the numeric keypad names also lose their doubled space (`8  (num)`). */
export function correctOriginalText(tables: Record<string, OriginalDataArray>): void {
  for (const correction of ORIGINAL_TEXT_CORRECTIONS) {
    const table = tables[correction.table]
    if (!table) continue
    const column = table.columns.findIndex(entry => entry.name === correction.column)
    const row = table.rows[correction.row]
    if (column < 0 || !row) throw new Error(`The ${correction.table} Data Array has no ${correction.column} row ${correction.row}`)
    const cell = row[column]
    if (cell === correction.corrected) continue
    if (typeof cell !== 'string' || textHash(cell) !== correction.original) throw new Error(`${correction.table} row ${correction.row} ${correction.column} is not the original text the correction was made for`)
    row[column] = correction.corrected
  }
  for (const row of tables.all_keys?.rows ?? []) {
    for (let column = 1; column < row.length; column++) {
      const cell = row[column]
      if (typeof cell === 'string') row[column] = cell.replace(/ {2,}\(num\)$/, ' (num)')
    }
  }
}
