const toFrameGroupsID = new Array()
var selections = mg.document.currentPage.selection
if (selections.length != 0) {
    // preProcess(selections)
    console.log("start")
    multiwayLayers(selections);
}

// function createText(){
//     font.loadFontAsync
// }

function preProcess(selections) {
    //flattenTextAndOperation
    for (var i = 0; i < selections.length; i++) {
        const node = selections[i]
        if (node.type == "FRAME" || node.type == "GROUP") {
            const nodeChildren = node.findAll(n => (n.type == "BOOLEAN_OPERATION"))
            for (var j = 0; j < nodeChildren.length; j++) {
                mg.flatten([nodeChildren[j]])
            }
        } else if (node.type == "BOOLEAN_OPERATION") {
            mg.flatten([node])
        }
    }
    mg.closePlugin()
}
async function multiwayLayers(selections) {
    for (var i = 0; i < selections.length; i++) {
        const selection = selections[i]
        var layerArray = recursionNode(selection)
        layerArray.push(toFrameGroupsID)

        // console.log(JSON.stringify(layerArray))
        const resultTextNode = await initTextNodeByChar(JSON.stringify(layerArray))
        selection.parent.appendChild(resultTextNode)
        resultTextNode.x = selection.x
        resultTextNode.y = selection.y
        resultTextNode.width = selection.width
        resultTextNode.textAutoResize = "HEIGHT"
        mg.document.currentPage.selection = [resultTextNode]
    }
    // mg.closePlugin()
}
function recursionNode(node) {
    var originArray = new Array()
    originArray.push(analyseNodes(node))
    if (node.type == "FRAME" || node.type == "GROUP" || node.type == "INSTANCE") {
        const nodeChildren = node.children
        if (nodeChildren.length > 0) {
            for (var i = 0; i < nodeChildren.length; i++) {
                originArray = originArray.concat(recursionNode(nodeChildren[i]))
            }
        }
    }
    // console.log(originArray)
    return originArray
}
function analyseNodes(node) {
    console.log(node.name)
    var finalNodeJson = ""
    if (node.type == "BOOLEAN_OPERATION") {
        //TODO: 有问题，回头来修
        finalNodeJson = transBONode(node)
    }else if (node.type == "COMPONENT"){
        //TODO: 待完成
    }else if (node.type == "COMPONENT_SET"){
        //TODO: 待完成
    } else if (node.type == "ELLIPSE") {
        finalNodeJson = transEllipseNode(node)
    } else if (node.type == "PEN") {
        finalNodeJson = transPenNode(node)
    } else if (node.type == "RECTANGLE") {
        finalNodeJson = transRectangleNode(node)
    } else if (node.type == "TEXT") {
        // var tempTextNodeClone = selection.clone()
        // node.remove()
        finalNodeJson = transTextNode(node)
        // finalNodeJson = transPenNode(selection.outlineStroke(selection.clone()))
    } else if (node.type == "STAR") {
        finalNodeJson = transStarNode(node)
    } else if (node.type == "LINE") {
        finalNodeJson = transLineNode(node)
    } else if (node.type == "POLYGON") {
        finalNodeJson = transPolygonNode(node)
    } else if (node.type == "FRAME") {
        finalNodeJson = transFrameNode(node)
    } else if (node.type == "GROUP") {
        toFrameGroupsID.push(node.id)
        finalNodeJson = transGroupNode(node)
    } else if (node.type == "INSTANCE") {
        finalNodeJson = transFrameNode(node)
    } else {
        finalNodeJson = {}
    }
    //  else if(node.type == "BOOLEAN_OPERATION"){
    //     var flattedShapeNode = mg.flatten([node])
    //     mg.notify(flattedShapeNode.type)
    //     mg.document.currentPage.selection = [flattedShapeNode]
    //     finalNodeJson = transPenNode(flattedShapeNode)
    //     // console.log(finalNodeJson)
    // }
    return finalNodeJson
    // const resultTextNode = await initTextNodeByChar(finalString)
    // selection.parent.appendChild(resultTextNode)
    // resultTextNode.x = selection.x
    // resultTextNode.y = selection.y
    // resultTextNode.width = selection.width
    // resultTextNode.textAutoResize = "HEIGHT"
    // mg.document.currentPage.selection = [resultTextNode]
    // mg.closePlugin()
}
function transBONode(node){
    var flattedShapeNode = mg.flatten([node])
    // console.log(flattedShapeNode)
    // console.log(transPenNode(flattedShapeNode))
    return transPenNode(flattedShapeNode)
}
function transPenNode(selection) {
    const universalStruct = getUniversalProperty(selection)

    const originJson = selection.penNetwork

    const originCtrlNodes = originJson.ctrlNodes
    const originNodes = originJson.nodes
    const originPaths = originJson.paths

    const resultSegments = new Array()

    for (var j = 0; j < originPaths.length; j++) {
        var tempStart = originPaths[j][0]
        var tempEnd = originPaths[j][3]

        var tempTangentStart = {
            x: 0,
            y: 0
        }
        var tempTangentEnd = {
            x: 0,
            y: 0
        }
        if (originPaths[j][1] != -1) {
            tempTangentStart.x = originCtrlNodes[originPaths[j][1]].x - originNodes[tempStart].x
            tempTangentStart.y = originCtrlNodes[originPaths[j][1]].y - originNodes[tempStart].y
        }
        if (originPaths[j][2] != -1) {
            tempTangentEnd.x = originCtrlNodes[originPaths[j][2]].x - originNodes[tempEnd].x
            tempTangentEnd.y = originCtrlNodes[originPaths[j][2]].y - originNodes[tempEnd].y
        }

        resultSegments.push({
            start: tempStart,
            end: tempEnd,
            tangentStart: tempTangentStart,
            tangentEnd: tempTangentEnd
        })
    }
    const finalPathJson = {
        "segments": resultSegments,
        "vertices": originNodes,
        "regions": []
    }

    const otherStruct = {
        "vectorNetwork": finalPathJson
    }

    const resultStruct = Object.assign(otherStruct, universalStruct)
    resultStruct.type = "VECTOR"
    return resultStruct
}
function transEllipseNode(selection) {
    const universalStruct = getUniversalProperty(selection)

    const otherStruct = {
        "arcData": selection.arcData
    }

    const resultStruct = Object.assign(otherStruct, universalStruct)
    return resultStruct
}
function transRectangleNode(selection) {
    const universalStruct = getUniversalProperty(selection)

    const otherStruct = {
    }

    const resultStruct = Object.assign(otherStruct, universalStruct)
    return resultStruct
}
function transStarNode(selection) {
    const universalStruct = getUniversalProperty(selection)

    const otherStruct = {
        "pointCount": selection.pointCount,
        "innerRadius": selection.innerRadius
    }

    const resultStruct = Object.assign(otherStruct, universalStruct)
    return resultStruct
}
function transLineNode(selection) {
    const universalStruct = getUniversalProperty(selection)

    const otherStruct = {
    }

    const resultStruct = Object.assign(otherStruct, universalStruct)
    return resultStruct
}
function transPolygonNode(selection) {
    const universalStruct = getUniversalProperty(selection)

    const otherStruct = {
        "pointCount": selection.pointCount
    }

    const resultStruct = Object.assign(otherStruct, universalStruct)
    return resultStruct
}
function transFrameNode(selection) {
    const universalStruct = getUniversalProperty(selection)
    const otherStruct = {
        "clipsContent": selection.clipsContent
    }

    const resultStruct = Object.assign(otherStruct, universalStruct)
    return resultStruct
}
function transGroupNode(selection) {
    const universalStruct = getUniversalProperty(selection)

    universalStruct.type = "FRAME"

    const otherStruct = {
        "clipsContent": false
    }

    const resultStruct = Object.assign(otherStruct, universalStruct)
    return resultStruct
}
function transTextNode(selection) {
    const universalStruct = getUniversalProperty(selection)
    var tempFontName = selection.textStyles[0].textStyle.fontName
    mg.notify(selection.textStyles[0].textStyle.fontName.family)
    if (selection.textStyles[0].textStyle.fontName.family == "AlibabaPuHuiTi") {
        tempFontName = {
            family: "Alibaba PuHuiTi",
            style: selection.textStyles[0].textStyle.fontName.style
        }
    }

    const otherStruct = {
        "textAlignHorizontal": selection.textAlignHorizontal,
        "textAlignVertical": selection.textAlignVertical,
        "textAutoResize": selection.textAutoResize,
        "paragraphIndent": 0,
        "paragraphSpacing": selection.paragraphSpacing,
        "autoRename": false,
        "characters": selection.characters,
        "fontSize": selection.textStyles[0].textStyle.fontSize,
        "fontName": tempFontName,
        "fontWeight": selection.textStyles[0].textStyle.fontWeight,
        "textCase": selection.textStyles[0].textStyle.textCase,
        "textDecoration": selection.textStyles[0].textStyle.textDecoration,
        "letterSpacing": selection.textStyles[0].textStyle.letterSpacing,
        "lineHeight": selection.textStyles[0].textStyle.lineHeight,
    }

    const resultStruct = Object.assign(otherStruct, universalStruct)
    return resultStruct
}
function transBooleanNode(selection) {
    return {}
    const universalStruct = getUniversalProperty(selection)

    const otherStruct = {
        "booleanOperation": selection.booleanOperation
    }

    const resultStruct = Object.assign(otherStruct, universalStruct)
    return resultStruct
}

function fillsAndStrokes2Json(fills, strokes) {
    //处理填充部分
    const originFills = fills
    const resultFills = new Array()
    for (var n = 0; n < originFills.length; n++) {
        var tempOriginFill = originFills[n]
        var tempResultFill = {}
        if (tempOriginFill.type == "SOLID") {
            tempResultFill = {
                "type": tempOriginFill.type,
                "visible": tempOriginFill.isVisible,
                "opacity": tempOriginFill.color.a,
                "blendMode": processBlendMode(tempOriginFill.blendMode),
                "color": {
                    "r": tempOriginFill.color.r,
                    "g": tempOriginFill.color.g,
                    "b": tempOriginFill.color.b
                }
            }
        } else if (tempOriginFill.type == "GRADIENT_LINEAR") {
            //处理矩阵
            tempResultFill = {
                "type": tempOriginFill.type,
                "visible": tempOriginFill.isVisible,
                "opacity": tempOriginFill.alpha,
                "blendMode": processBlendMode(tempOriginFill.blendMode),
                "gradientStops": rountGradientStops(tempOriginFill.gradientStops),
                "gradientTransform": getResultArrayByTwoPoint(tempOriginFill.gradientHandlePositions)
            }
        } else if (tempOriginFill.type == "GRADIENT_RADIAL" || tempOriginFill.type == "GRADIENT_ANGULAR" || tempOriginFill.type == "GRADIENT_DIAMOND") {
            tempResultFill = {
                "type": tempOriginFill.type,
                "visible": tempOriginFill.isVisible,
                "opacity": tempOriginFill.alpha,
                "blendMode": processBlendMode(tempOriginFill.blendMode),
                "gradientStops": rountGradientStops(tempOriginFill.gradientStops),
                "gradientTransform": [
                    [
                        0,
                        1,
                        0
                    ],
                    [
                        -1,
                        0,
                        1
                    ]
                ]
            }
        } else if (tempOriginFill.type = "IMAGE") {
            mg.notify(tempOriginFill.blendMode)
            //TODO: Image 先使用缺省图片
            tempResultFill = {
                "blendMode": processBlendMode(tempOriginFill.blendMode),
                "imageHash": "eae313a48883a46e7a2a60ee806e73a8052191be",
                "opacity": tempOriginFill.alpha,
                "type": "IMAGE",
                "scaleMode": tempOriginFill.scaleMode,
                "visible": tempOriginFill.isVisible
            }
        }
        resultFills.push(tempResultFill)
    }

    //处理描边部分
    console.log("处理描边部分")
    const originStrokes = strokes
    console.log(originStrokes)
    const resultStrokes = new Array()
    for (var m = 0; m < originStrokes.length; m++) {
        var tempOriginStroke = originStrokes[m]
        var tempResultStroke = {}
        console.log(tempOriginStroke.type)
        if (tempOriginStroke.type == "SOLID") {
            tempResultStroke = {
                "type": tempOriginStroke.type,
                "visible": tempOriginStroke.isVisible,
                "opacity": tempOriginStroke.color.a,
                "blendMode": tempOriginStroke.blendMode,
                "color": {
                    "r": tempOriginStroke.color.r,
                    "g": tempOriginStroke.color.g,
                    "b": tempOriginStroke.color.b
                }
            }
        } else if (tempOriginStroke.type == "GRADIENT_LINEAR") {
            //处理矩阵
            console.log("处理矩阵")
            tempResultFill = {
                "type": tempOriginStroke.type,
                "visible": tempOriginStroke.isVisible,
                "opacity": tempOriginStroke.alpha,
                "blendMode": tempOriginStroke.blendMode,
                "gradientStops": rountGradientStops(tempOriginStroke.gradientStops),
                "gradientTransform": getResultArrayByTwoPoint(tempOriginStroke.gradientHandlePositions)
            }
        } else if (tempOriginStroke.type == "GRADIENT_RADIAL" || tempOriginStroke.type == "GRADIENT_ANGULAR" || tempOriginStroke.type == "GRADIENT_DIAMOND") {
            tempResultStroke = {
                "type": tempOriginStroke.type,
                "visible": tempOriginStroke.isVisible,
                "opacity": tempOriginStroke.alpha,
                "blendMode": tempOriginStroke.blendMode,
                "gradientStops": rountGradientStops(tempOriginStroke.gradientStops),
                "gradientTransform": [
                    [
                        0,
                        1,
                        0
                    ],
                    [
                        -1,
                        0,
                        1
                    ]
                ]
            }
        }
        resultStrokes.push(tempResultStroke)
    }

    return {
        fills: resultFills,
        strokes: resultStrokes
    }
}

function rountGradientStops(gradientStops) {
    var tempStops = gradientStops
    for (var i = 0; i < tempStops.length; i++) {
        tempStops[i].position = tempStops[i].position > 1 ? 1 : tempStops[i].position
        tempStops[i].color.a = tempStops[i].color.a > 1 ? 1 : tempStops[i].color.a
    }
    return tempStops
}
//通过 gradientHandlePositions 计算变化矩阵

function getResultArrayByTwoPoint(points) {
    if(points == undefined){
        console.log("getResultArrayByTwoPoint 传入错误参数")
        return [[1,0,0],[0,1,0]]
    }
    console.log(points)
    //
    var x3 = points[0].x
    var y3 = points[0].y
    var x4 = points[1].x
    var y4 = points[1].y

    const matrix1 = [[1, 0, 0], [0, 1, 0.5], [0, 0, 1]]
    const lengthen = Math.sqrt((x4 - x3) * (x4 - x3) + (y4 - y3) * (y4 - y3))
    const matrix2 = [[1 / lengthen, 0, 0], [0, 1, 0], [0, 0, 1]]
    const sina = (y3 - y4) / lengthen
    const cosa = (x4 - x3) / lengthen
    const matrix3 = [[cosa, -sina, 0], [sina, cosa, 0], [0, 0, 1]]
    const matrix4 = [[1, 0, -x3], [0, 1, -y3], [0, 0, 1]]

    const matrix1_2 = matrixMultiplication(matrix2, matrix1)
    const matrix1_2_3 = matrixMultiplication(matrix1_2, matrix3)
    const matrix1_2_3_4 = matrixMultiplication(matrix1_2_3, matrix4)
    //console.log(matrix1_2_3_4)
    return [matrix1_2_3_4[0],matrix1_2_3_4[1]]

    function matrixMultiplication(matrix1, matrix2) {
      let result = new Array();
      for (let i = 0; i < matrix1.length; i++) {
        result[i] = [];
        for (let j = 0; j < matrix2[0].length; j++) {
          let sum = 0;
          for (let k = 0; k < matrix2.length; k++) {
            sum += matrix1[i][k] * matrix2[k][j];
          }
          result[i][j] = sum;
        }
      }
      return result;
    }
}

function getUniversalProperty(selection) {

    var tempFillsAndStrokes = fillsAndStrokes2Json(selection.fills, selection.strokes)

    const resultFills = tempFillsAndStrokes.fills
    const resultStrokes = tempFillsAndStrokes.strokes

    var fourCornerRadius = {
        topLeftRadius: selection.topLeftRadius == undefined ? 0 : selection.topLeftRadius,
        topRightRadius: selection.topRightRadius == undefined ? 0 : selection.topRightRadius,
        bottomLeftRadius: selection.bottomLeftRadius == undefined ? 0 : selection.bottomLeftRadius,
        bottomRightRadius: selection.bottomRightRadius == undefined ? 0 : selection.bottomRightRadius
    }
    var resultCornerRadius = selection.cornerRadius == undefined ? 0 : selection.cornerRadius
    if (resultCornerRadius == "Symbol(mg.mixed)") {
        resultCornerRadius = -1
    }
    var resultCornerSmoothing = selection.cornerSmooth
    resultCornerSmoothing = (resultCornerSmoothing == undefined ? 0 : resultCornerSmoothing)

    var effectsArray = new Array()
    for (var i = 0; i < selection.effects.length; i++) {
        var tempEffect = selection.effects[i]
        if (tempEffect.type == "DROP_SHADOW" || tempEffect.type == "INNER_SHADOW") {
            effectsArray.push({
                "type": tempEffect.type,
                "color": tempEffect.color,
                "offset": tempEffect.offset,
                "radius": tempEffect.radius,
                "spread": tempEffect.spread,
                "visible": tempEffect.isVisible,
                "blendMode": processBlendMode(tempEffect.blendMode)
            })
        } else if (tempEffect.type == 'LAYER_BLUR' || tempEffect.type == 'BACKGROUND_BLUR') {
            effectsArray.push({
                "type": tempEffect.type,
                "radius": tempEffect.radius,
                "visible": tempEffect.isVisible
            })
        }
    }
    const universalStruct = {
        "type": selection.type,
        "id": selection.id,
        "name": selection.name,
        "parentID": (selection.parent.type == "PAGE" ? null : selection.parent.id),
        "scence": {
            "visible": selection.isVisible,
            "locked": selection.isLocked
        },
        "blend": {
            "opacity": selection.opacity,
            "isMask": selection.isMask,
            "blendMode": processBlendMode(selection.blendMode),
            "effects": effectsArray
        },
        "corner": {
            "topLeftRadius": fourCornerRadius.topLeftRadius,
            "topRightRadius": fourCornerRadius.topRightRadius,
            "bottomLeftRadius": fourCornerRadius.bottomLeftRadius,
            "bottomRightRadius": fourCornerRadius.bottomRightRadius,
            "cornerRadius": resultCornerRadius,
            "cornerSmoothing": resultCornerSmoothing
        },
        "geometry": {
            "fills": resultFills,
            "strokes": resultStrokes,
            "strokeWeight": selection.strokeWeight,
            "strokeAlign": selection.strokeAlign,
            "strokeJoin": selection.strokeJoin,
            "dashPattern": selection.strokeDashes,
            "strokeCap": selection.strokeCap,
        },
        "layout": {
            "relativeTransform": selection.relativeTransform,
            "x": selection.x,
            "y": selection.y,
            "rotation": -selection.rotation,
            "width": selection.width,
            "height": selection.height
        }
    }
    return universalStruct

}
async function initTextNodeByChar(characters) {
    //初始化字体
    await mg.loadFontAsync({
        family: "Source Han Sans",
        style: "Regular"
    })
    const tempNode = mg.createText()
    tempNode.setRangeFontName(0, tempNode.characters.length, {
        family: "Source Han Sans",
        style: "Regular"
    })
    tempNode.characters = characters
    return tempNode
}

//Tool Functions

/**
 * 处理混合模式的函数
 * @param blendMode 指定的混合模式，可以是任意字符串，但特定值会有特殊处理
 * @return 返回处理后的混合模式字符串。如果输入为"PLUS_DARKER"或"PASS_THROUGH"，则返回"NORMAL"。
 */
function processBlendMode(blendMode) {
    var resultBlenderMode = blendMode // 初始化返回值为传入的混合模式
    // 特殊处理"PLUS_DARKER"和"PASS_THROUGH"两种模式，将其视为"NORMAL"模式
    if (resultBlenderMode == "PLUS_DARKER" || resultBlenderMode == "PASS_THROUGH") {
        resultBlenderMode = "NORMAL"
    }
    return resultBlenderMode // 返回处理后的混合模式
}