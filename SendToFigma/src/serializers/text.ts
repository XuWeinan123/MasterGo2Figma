import { getUniversalProperty, readNodeProperty, cloneJsonCompatible } from "./universal";

export function transTextNode(selection: any) {
    const universalStruct = getUniversalProperty(selection);
    const textStyles = readNodeProperty<any[]>(selection, "textStyles", []);
    let tempFontName = cloneJsonCompatible(textStyles?.[0]?.textStyle?.fontName, undefined);

    if (tempFontName && tempFontName.family === "AlibabaPuHuiTi") {
        tempFontName = {
            family: "Alibaba PuHuiTi",
            style: tempFontName.style
        };
    }

    const style = textStyles?.[0]?.textStyle || {};

    const otherStruct = {
        "textAlignHorizontal": readNodeProperty(selection, "textAlignHorizontal", "LEFT"),
        "textAlignVertical": readNodeProperty(selection, "textAlignVertical", "TOP"),
        "textAutoResize": readNodeProperty(selection, "textAutoResize", "NONE"),
        "paragraphIndent": 0,
        "paragraphSpacing": readNodeProperty(selection, "paragraphSpacing", 0),
        "autoRename": false,
        "characters": readNodeProperty(selection, "characters", ""),
        "fontSize": style.fontSize,
        "fontName": tempFontName,
        "fontWeight": style.fontWeight,
        "textCase": style.textCase,
        "textDecoration": style.textDecoration,
        "letterSpacing": cloneJsonCompatible(style.letterSpacing, style.letterSpacing),
        "lineHeight": cloneJsonCompatible(style.lineHeight, style.lineHeight),
    };

    return Object.assign(otherStruct, universalStruct);
}
