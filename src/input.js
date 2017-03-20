const {Slice} = require("prosemirror-model")
const {Selection, TextSelection} = require("prosemirror-state")
const {keydownHandler} = require("prosemirror-keymap")

const {key, moveCellPos, moveCellForward, cellAround, inSameTable} = require("./util")
const {CellSelection} = require("./cellselection")

exports.handleKeyDown = keydownHandler({
  "ArrowLeft": arrow("horiz", -1),
  "ArrowRight": arrow("horiz", 1),
  "ArrowUp": arrow("vert", -1),
  "ArrowDown": arrow("vert", 1),

  "Shift-ArrowLeft": shiftArrow("horiz", -1),
  "Shift-ArrowRight": shiftArrow("horiz", 1),
  "Shift-ArrowUp": shiftArrow("vert", -1),
  "Shift-ArrowDown": shiftArrow("vert", 1),

  "Backspace": deleteCellSelection,
  "Mod-Backspace": deleteCellSelection,
  "Delete": deleteCellSelection,
  "Mod-Delete": deleteCellSelection
})

function arrow(axis, dir) {
  return (state, dispatch, view) => {
    let sel = state.selection
    if (sel instanceof CellSelection) {
      dispatch(state.tr.setSelection(Selection.near(sel.$head, dir)))
      return true
    }
    if (axis != "horiz" && !sel.empty) return false
    let end = atEndOfCell(view, axis, dir)
    if (end == null) return false
    if (axis == "horiz") {
      dispatch(state.tr.setSelection(Selection.near(state.doc.resolve(sel.head + dir), dir)))
      return true
    } else {
      let $cell = state.doc.resolve(end), $next = moveCellPos($cell, axis, dir), newSel
      if ($next) newSel = Selection.near($next, 1)
      else if (dir < 0) newSel = Selection.near(state.doc.resolve($cell.before(-1)), -1)
      else newSel = Selection.near(state.doc.resolve($cell.after(-1)), 1)
      dispatch(state.tr.setSelection(newSel))
      return true
    }
  }
}

function shiftArrow(axis, dir) {
  return (state, dispatch, view) => {
    let sel = state.selection
    if (!(sel instanceof CellSelection)) {
      let end = atEndOfCell(view, axis, dir)
      if (end == null) return false
      sel = CellSelection.between(state.doc.resolve(end))
    }
    let $head = moveCellPos(sel.$head, axis, dir), $anchor = sel.$anchor
    if ($head.parent.type.name != "table_row") throw new RangeError("BAD HEAD " + $head)
    if (!$head) return false
    if ($head.pos == $anchor.pos) {
      $head = moveCellPos($anchor, axis, dir)
      if (!$head) return false
      $anchor = sel.$head
    }
    if (dispatch) dispatch(state.tr.setSelection(new CellSelection($anchor, $head)))
    return true
  }
}

function deleteCellSelection(state, dispatch) {
  let sel = state.selection
  if (!(sel instanceof CellSelection)) return false
  if (dispatch) {
    let tr = state.tr, baseContent = state.schema.nodes.table_cell.createAndFill().content
    sel.forEachCell((cell, pos) => {
      if (!cell.content.eq(baseContent))
        tr.replace(tr.mapping.map(pos + 1), tr.mapping.map(pos + cell.nodeSize - 1),
                   new Slice(baseContent, 0, 0))
    })
    if (tr.docChanged) dispatch(tr)
  }
  return true
}

exports.handleTripleClick = function(view, pos) {
  let doc = view.state.doc, $pos = doc.resolve(pos)
  for (let i = $pos.depth; i > 0; i--) {
    let parent = $pos.node(i)
    if (parent.type.name == "table_cell" || parent.type.name == "table_header") {
      view.dispatch(view.state.tr.setSelection(new CellSelection(doc.resolve($pos.before(i)),
                                                                 doc.resolve($pos.after(i)))))
      return true
    }
  }
  return false
}

exports.handleTextInput = function(view, _from, _to, text) {
  let {selection, doc} = view.state
  if (!(selection instanceof CellSelection)) return false
  let $cell = doc.resolve(selection.headCellPos)
  view.dispatch(view.state.tr
                .setSelection(TextSelection.between($cell, moveCellForward($cell)))
                .insertText(text))
  return true
}

exports.mousedown = function(view, startEvent) {
  if (startEvent.ctrlKey || startEvent.metaKey) return

  let startDOMCell = domInCell(view, startEvent.target), anchor
  if (startEvent.shiftKey && (view.state.selection instanceof CellSelection)) {
    setCellSelection(view.state.selection.anchorCellPos, startEvent)
    startEvent.preventDefault()
  } else if (startEvent.shiftKey && startDOMCell &&
             (anchor = cellAround(view.state.selection.$anchor)) != null &&
             cellUnderMouse(view, startEvent) != anchor) {
    setCellSelection(anchor, startEvent)
    startEvent.preventDefault()
  } else if (!startDOMCell) {
    return
  }

  function setCellSelection(anchor, event) {
    let $anchor = view.state.doc.resolve(anchor)
    let head = cellUnderMouse(view, event), $head
    let starting = key.getState(view.state) == null
    if (head == null || !inSameTable($anchor, $head = view.state.doc.resolve(head))) {
      if (starting) $head = $anchor
      else return
    }
    let selection = CellSelection.between($anchor, $head)
    if (starting || !view.state.selection.eq(selection)) {
      let tr = view.state.tr.setSelection(selection)
      if (starting) tr.setMeta(key, anchor)
      view.dispatch(tr)
    }
  }

  function stop() {
    view.root.removeEventListener("mouseup", stop)
    view.root.removeEventListener("mousemove", move)
    if (key.getState(view.state) != null) view.dispatch(view.state.tr.setMeta(key, -1))
  }

  function move(event) {
    let anchor = key.getState(view.state)
    if (anchor == null && domInCell(view, event.target) != startDOMCell) {
      anchor = cellUnderMouse(view, startEvent)
      if (anchor == null) return stop()
    }
    if (anchor != null) setCellSelection(anchor, event)
  }
  view.root.addEventListener("mouseup", stop)
  view.root.addEventListener("mousemove", move)
}

function atEndOfCell(view, axis, dir) {
  if (!(view.state.selection instanceof TextSelection)) return null
  let {$head} = view.state.selection
  if (!$head) return null
  for (let d = $head.depth - 1; d >= 0; d--) {
    let parent = $head.node(d), index = dir < 0 ? $head.index(d) : $head.indexAfter(d)
    if (index != (dir < 0 ? 0 : parent.childCount)) return null
    if (parent.type.name == "table_cell" || parent.type.name == "table_header") {
      let cellPos = $head.before(d)
      let dirStr = axis == "vert" ? (dir > 0 ? "down" : "up") : (dir > 0 ? "right" : "left")
      return view.endOfTextblock(dirStr) ? cellPos : null
    }
  }
  return null
}

function domInCell(view, dom) {
  for (; dom && dom != view.dom; dom = dom.parentNode)
    if (dom.nodeName == "TD" || dom.nodeName == "TH") return dom
}

function cellUnderMouse(view, event) {
  let mousePos = view.posAtCoords({left: event.clientX, top: event.clientY})
  if (!mousePos) return null
  return mousePos ? cellAround(view.state.doc.resolve(mousePos.pos)) : null
}
