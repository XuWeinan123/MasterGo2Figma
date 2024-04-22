# MasterGo2Figma

​	最近要把设计稿都从 MasterGo 转去 Figma 了，MasterGo 很多功能没有。

​	之前的设计稿转移起来还挺麻烦的，的确可以从 MasterGo 导出 Sketch 然后在 Figma 导入，但是效果太差了啊。

​	所以写了这么一个插件，虽然还有很多东西不支持转移，慢慢来吧。

​	也希望有空的全栈设计师帮忙写一点，我不常上 Github，但是提交的代码我一定会看的

## 用法

​	Basically，我在 MasterGo 里通过插件把图层变成 Json 文本，然后直接复制到 Figma 里，再用对应的插件还原。

​	所以要在 MasterGo 里装上插件 SendToFigma ，然后到 Figma 转上插件 ReceiveFromMasterGo。
​	在 MasterGo 里选中一个图层，比如一个“联集”，也就是布尔图层。然后运行插件，会得到一个文本图层。

![image-20240422234655227](/Users/xuweinan/Documents/GitHub/MasterGo2Figma/README/image-20240422234655227.png)

​	不用看懂。直接把这个复制到 Figma 里，直接复制就行换不换行影响不大。

![image-20240422234756970](/Users/xuweinan/Documents/GitHub/MasterGo2Figma/README/image-20240422234756970.png)

然后运行 ReceiveFromMasterGo 插件，神奇的事情就发生了。

![image-20240422234821868](/Users/xuweinan/Documents/GitHub/MasterGo2Figma/README/image-20240422234821868.png)

名字，填充，描边什么的都会还原。

## 进度

https://linear.app/comicandmanga/team/MAS/active  (不知道陌生人能不能看)
总之目前是这个进度：

![image-20240422234949289](/Users/xuweinan/Documents/GitHub/MasterGo2Figma/README/image-20240422234949289.png)



估计后面没什么时间写，不用对这个项目抱有太大期望。

