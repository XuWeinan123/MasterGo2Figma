
// 打印
// var selections = figma.currentPage.selection
// if (selections.length != 0) {
//     for (var i = 0; i < selections.length; i++) {
//         var selection = selections[i]
//         console.log(selection)
//         console.log(selection.strokes)
//     }
// }
// figma.closePlugin()

//当前文档所有的字体
var documentFonts = new Array()
receive()
async function receive() {
  var selections = figma.currentPage.selection
  if (selections.length >= 1) {
    for (var i = 0; i < selections.length; i++) {
      const selection = selections[i]
      if (selection.type == "TEXT") {
        var tempArray = JSON.parse(selection.characters)
        var thisTimeAddNodes = new Array()
        for (var j = 0; j < tempArray.length - 1; j++) {
          var tempJson = tempArray[j]
          // console.log(tempJson.name)
          var finalNode
          const supportType = ["VECTOR", "ELLIPSE", "RECTANGLE", "STAR", "LINE", "POLYGON", "FRAME", "TEXT", "INSTANCE"]
          if (tempJson.type == "VECTOR") {
            finalNode = figma.createVector()
            finalNode.vectorNetwork = tempJson.vectorNetwork
          } else if (tempJson.type == "ELLIPSE") {
            finalNode = figma.createEllipse()
            finalNode.arcData = tempJson.arcData
          } else if (tempJson.type == "RECTANGLE") {
            finalNode = figma.createRectangle()
          } else if (tempJson.type == "STAR") {
            finalNode = figma.createStar()
            finalNode.pointCount = tempJson.pointCount
            finalNode.innerRadius = tempJson.innerRadius
          } else if (tempJson.type == "LINE") {
            finalNode = figma.createLine()
          } else if (tempJson.type == "POLYGON") {
            finalNode = figma.createPolygon()
            finalNode.pointCount = tempJson.pointCount
          } else if (tempJson.type == "FRAME") {
            finalNode = figma.createFrame()
            finalNode.clipsContent = tempJson.clipsContent
          } else if (tempJson.type == "TEXT") {
            finalNode = figma.createText()
          } else if (tempJson.type == "INSTANCE") {
            finalNode = figma.createFrame()
          } else if (tempJson.type == "BOOLEAN_OPERATION") {
            finalNode = figma.createFrame()
          }

          //如果在支持的类型中，就开始添加通用属性
          if (finalNode != null && (supportType.indexOf(tempJson.type) != -1)) {
            //基础属性
            finalNode.name = tempJson.name
            var tempParent = null
            for (var m = 0; m < thisTimeAddNodes.length; m++) {
              if (thisTimeAddNodes[m].originID == tempJson.parentID) {
                tempParent = thisTimeAddNodes[m].node
              }
            }
            if (tempParent == null) {
              figma.currentPage.appendChild(finalNode)
            } else {
              // console.log(tempJson.name + " 的父亲是 " + tempParent.name + tempParent.type)
              tempParent.appendChild(finalNode)
            }

            //场景属性
            finalNode.visible = tempJson.scence.visible
            finalNode.locked = tempJson.scence.locked

            //渲染属性
            finalNode.opacity = tempJson.blend.opacity
            finalNode.isMask = tempJson.blend.isMask
            finalNode.blendMode = tempJson.blend.blendMode
            console.log(finalNode.name)
            finalNode.effects = tempJson.blend.effects

            //角落属性
            if (finalNode.type != "LINE" && finalNode.type != "TEXT") {
              if (tempJson.corner.cornerRadius == -1) {
                if (finalNode.type == "RECTANGLE" || finalNode.type == "FRAME") {
                  finalNode.topLeftRadius = tempJson.corner.topLeftRadius
                  finalNode.topRightRadius = tempJson.corner.topRightRadius
                  finalNode.bottomLeftRadius = tempJson.corner.bottomLeftRadius
                  finalNode.bottomRightRadius = tempJson.corner.bottomRightRadius
                }
              } else {
                finalNode.cornerRadius = tempJson.corner.cornerRadius
              }
              finalNode.cornerSmoothing = tempJson.corner.cornerSmoothing
            }

            //几何属性
            finalNode.fills = tempJson.geometry.fills
            finalNode.strokes = tempJson.geometry.strokes
            finalNode.strokeWeight = tempJson.geometry.strokeWeight
            finalNode.strokeAlign = tempJson.geometry.strokeAlign
            finalNode.strokeJoin = tempJson.geometry.strokeJoin
            finalNode.dashPattern = tempJson.geometry.dashPattern
            finalNode.strokeCap = tempJson.geometry.strokeCap

            //布局属性
            finalNode.relativeTransform = tempJson.layout.relativeTransform
            finalNode.x = tempJson.layout.x
            finalNode.y = tempJson.layout.y
            finalNode.rotation = tempJson.layout.rotation
            finalNode.resize(tempJson.layout.width, tempJson.layout.height)


            //如果是文本图层，需要在基础属性设置之后再设置独特属性
            if (finalNode.type == "TEXT") {

              //判断有没有字体
              if (documentFonts.length == 0) {
                documentFonts = await figma.listAvailableFontsAsync()
              }
              var isFontExist = false
              for (var n = 0; n < documentFonts.length; n++) {
                if (documentFonts[n].fontName.family == tempJson.fontName.family && documentFonts[n].fontName.style == tempJson.fontName.style) {
                  isFontExist = true
                }
              }
              // console.log(isFontExist + " | " + tempJson.fontName.family + " | " + tempJson.fontName.style)


              //初始化默认字体
              await figma.loadFontAsync({
                family: "Inter",
                style: "Regular"
              })
              if (isFontExist) {
                await figma.loadFontAsync(tempJson.fontName)
              } else {
                //在图层名上做标记
                finalNode.name = "[字体缺失][" + tempJson.fontName.family + "][" + tempJson.fontName.style + "] " + finalNode.name
              }

              finalNode.textAlignHorizontal = tempJson.textAlignHorizontal
              finalNode.textAlignVertical = tempJson.textAlignVertical
              finalNode.textAutoResize = tempJson.textAutoResize
              finalNode.paragraphIndent = tempJson.paragraphIndent
              finalNode.paragraphSpacing = tempJson.paragraphSpacing
              finalNode.autoRename = tempJson.autoRename
              finalNode.characters = tempJson.characters
              finalNode.fontSize = tempJson.fontSize
              finalNode.fontName = isFontExist ? tempJson.fontName : {
                family: "Inter",
                style: "Regular"
              }
              finalNode.textCase = tempJson.textCase
              finalNode.textDecoration = tempJson.textDecoration
              finalNode.letterSpacing = tempJson.letterSpacing
              finalNode.lineHeight = tempJson.lineHeight
            }

            // selection.parent?.appendChild(finalNode)
            thisTimeAddNodes.push({
              node: finalNode,
              originID: tempJson.id
            })
          }

        }
        //把所有符合条件的 id 的 Frame 转成 Group
        const toFrameGroupsID = tempArray[tempArray.length - 1]
        // console.log(toFrameGroupsID)
        // console.log(thisTimeAddNodes)
        for (var o = 0; o < thisTimeAddNodes.length; o++) {
          for (var p = 0; p < toFrameGroupsID.length; p++) {
            if (toFrameGroupsID[p] == thisTimeAddNodes[o].originID) {
              //如果 Group 的旋转不为 0 ，那么暂时不变组，暂时解决不了这个问题
              console.log(thisTimeAddNodes[o].node.name + " | " + thisTimeAddNodes[o].node.rotation)
              if (thisTimeAddNodes[o].node.rotation == 0) {
                transFrameToGroup(thisTimeAddNodes[o].node)
              }
            }
          }
        }
        //把所有符合条件的布尔图层 Frame 转成 布尔图层

        thisTimeAddNodes[0].node.x = selection.x
        thisTimeAddNodes[0].node.y = selection.y
        selection.remove()
        figma.currentPage.selection = [thisTimeAddNodes[0].node]
      }
    }
  }

  function transFrameToGroup(frameNode: FrameNode) {
    //处理一下旋转
    const tempRotation = frameNode.rotation
    frameNode.rotation = 0

    var tempParent = frameNode.parent
    console.log(frameNode.name + " 序号 " + tempParent?.children.indexOf(frameNode))
    var indexOf = tempParent?.children.indexOf(frameNode)
    var groupedNode
    if (tempParent != null) {
      groupedNode = figma.group([frameNode], tempParent, indexOf)
      groupedNode.name = frameNode.name
    } else {
      groupedNode = figma.group([frameNode], figma.currentPage, indexOf)
      groupedNode.name = frameNode.name
    }
    groupedNode.x = frameNode.x
    groupedNode.y = frameNode.y
    figma.ungroup(frameNode)
    groupedNode.rotation = tempRotation
  }

  figma.closePlugin()
}