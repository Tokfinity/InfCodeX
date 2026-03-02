/**
 * TextBuffer 单元测试
 *
 * 测试多行文本缓冲区的核心功能
 */

import { describe, it, expect, beforeEach } from "vitest";
import { TextBuffer } from "@kodax/repl";

describe("TextBuffer", () => {
  let buffer: TextBuffer;

  beforeEach(() => {
    buffer = new TextBuffer();
  });

  describe("初始状态", () => {
    it("应该从空文本开始", () => {
      expect(buffer.text).toBe("");
      expect(buffer.lines).toEqual([""]);
      expect(buffer.cursor).toEqual({ row: 0, col: 0 });
      expect(buffer.isEmpty).toBe(true);
      expect(buffer.lineCount).toBe(1);
    });

    it("光标应该在第一行第一列", () => {
      expect(buffer.cursor.row).toBe(0);
      expect(buffer.cursor.col).toBe(0);
    });
  });

  describe("insert() - 插入文本", () => {
    it("应该在光标位置插入文本", () => {
      buffer.insert("Hello");
      expect(buffer.text).toBe("Hello");
      expect(buffer.cursor.col).toBe(5);
    });

    it("应该在正确位置连续插入", () => {
      buffer.insert("Hello");
      buffer.insert(" ");
      buffer.insert("World");
      expect(buffer.text).toBe("Hello World");
      expect(buffer.cursor.col).toBe(11);
    });

    it("应该处理 Unicode 字符（emoji）", () => {
      buffer.insert("👋");
      expect(buffer.text).toBe("👋");
      expect(buffer.cursor.col).toBe(1); // 一个 code point
    });

    it("应该处理多字节 Unicode 字符（中文）", () => {
      buffer.insert("你好世界");
      expect(buffer.text).toBe("你好世界");
      expect(buffer.cursor.col).toBe(4);
    });

    it("应该处理混合 Unicode 内容", () => {
      buffer.insert("Hi 👋 你好");
      expect(buffer.text).toBe("Hi 👋 你好");
      // H, i, space, 👋, space, 你, 好 = 7 code points
      expect(buffer.cursor.col).toBe(7);
    });
  });

  describe("setText() - 设置文本", () => {
    it("应该替换整个文本内容", () => {
      buffer.insert("Old");
      buffer.setText("New");
      expect(buffer.text).toBe("New");
    });

    it("应该正确分割多行文本", () => {
      buffer.setText("Line1\nLine2\nLine3");
      expect(buffer.lines).toEqual(["Line1", "Line2", "Line3"]);
      expect(buffer.lineCount).toBe(3);
    });

    it("应该限制光标在有效范围内", () => {
      buffer.setText("Short");
      buffer.move("end");
      buffer.setText("A"); // 文本变短，光标应该被限制
      expect(buffer.cursor.col).toBeLessThanOrEqual(1);
    });
  });

  describe("newline() - 换行", () => {
    it("应该在光标位置插入换行符", () => {
      buffer.insert("HelloWorld");
      buffer.move("home");
      buffer.move("right"); // 移动到 'e' 后面
      buffer.move("right");
      buffer.move("right");
      buffer.move("right");
      buffer.move("right"); // 在 'W' 前面
      buffer.newline();
      expect(buffer.lines).toEqual(["Hello", "World"]);
      expect(buffer.cursor.row).toBe(1);
      expect(buffer.cursor.col).toBe(0);
    });

    it("应该在行尾插入换行符", () => {
      buffer.insert("Hello");
      buffer.newline();
      expect(buffer.lines).toEqual(["Hello", ""]);
      expect(buffer.cursor.row).toBe(1);
    });

    it("应该在空行插入换行符", () => {
      buffer.newline();
      expect(buffer.lines).toEqual(["", ""]);
      expect(buffer.lineCount).toBe(2);
    });
  });

  describe("backspace() - 退格删除", () => {
    it("应该删除光标前的字符", () => {
      buffer.insert("Hello");
      buffer.move("left");
      buffer.backspace(); // 删除 'l'
      expect(buffer.text).toBe("Helo");
    });

    it("应该在行首时合并到上一行", () => {
      buffer.insert("Line1");
      buffer.newline();
      buffer.insert("Line2");
      buffer.move("home");
      buffer.backspace();
      expect(buffer.text).toBe("Line1Line2");
      expect(buffer.lineCount).toBe(1);
    });

    it("应该在第一行行首时不做任何操作", () => {
      buffer.insert("Hello");
      buffer.move("home");
      buffer.backspace();
      expect(buffer.text).toBe("Hello");
    });

    it("应该正确处理 Unicode 退格", () => {
      buffer.insert("👋🌍");
      buffer.backspace();
      expect(buffer.text).toBe("👋");
    });
  });

  describe("delete() - 删除光标后字符", () => {
    it("应该删除光标位置的字符", () => {
      buffer.insert("Hello");
      buffer.move("home");
      buffer.delete(); // 删除 'H'
      expect(buffer.text).toBe("ello");
    });

    it("应该在行尾时合并下一行", () => {
      buffer.insert("Line1");
      buffer.newline();
      buffer.insert("Line2");
      buffer.move("up");
      buffer.move("end");
      buffer.delete();
      expect(buffer.text).toBe("Line1Line2");
    });

    it("应该在不做任何操作当在最后一行行尾", () => {
      buffer.insert("Hello");
      buffer.move("end");
      buffer.delete();
      expect(buffer.text).toBe("Hello");
    });
  });

  describe("move() - 光标移动", () => {
    beforeEach(() => {
      buffer.setText("Line1\nLine2\nLine3");
    });

    describe("left/right", () => {
      it("应该左右移动光标", () => {
        buffer.move("end");
        expect(buffer.cursor.col).toBe(5);
        buffer.move("left");
        expect(buffer.cursor.col).toBe(4);
        buffer.move("right");
        expect(buffer.cursor.col).toBe(5);
      });

      it("应该在行尾时移动到下一行开头", () => {
        buffer.move("home");
        buffer.move("end");
        buffer.move("right");
        expect(buffer.cursor.row).toBe(1);
        expect(buffer.cursor.col).toBe(0);
      });

      it("应该在行首时移动到上一行末尾", () => {
        buffer.move("end");
        buffer.move("down");
        buffer.move("home");
        buffer.move("left");
        expect(buffer.cursor.row).toBe(0);
        expect(buffer.cursor.col).toBe(5);
      });
    });

    describe("up/down", () => {
      it("应该上下移动行", () => {
        buffer.move("down");
        expect(buffer.cursor.row).toBe(1);
        buffer.move("down");
        expect(buffer.cursor.row).toBe(2);
        buffer.move("up");
        expect(buffer.cursor.row).toBe(1);
      });

      it("应该在第一行时不能上移", () => {
        buffer.move("up");
        expect(buffer.cursor.row).toBe(0);
      });

      it("应该在最后一行时不能下移", () => {
        buffer.move("down");
        buffer.move("down");
        buffer.move("down");
        expect(buffer.cursor.row).toBe(2);
      });

      it("应该记住列位置（remembered column）", () => {
        buffer.setText("LongLine\nShort\nLongLine");
        buffer.move("end"); // col = 8
        buffer.move("down"); // 移动到 Short 行，但记住 col = 8
        expect(buffer.cursor.col).toBe(5); // 限制在 Short 长度内
        buffer.move("down"); // 移动到 LongLine 行
        expect(buffer.cursor.col).toBe(8); // 恢复记住的列位置
      });
    });

    describe("home/end", () => {
      it("应该移动到行首", () => {
        buffer.move("end");
        buffer.move("home");
        expect(buffer.cursor.col).toBe(0);
      });

      it("应该移动到行尾", () => {
        buffer.move("home");
        buffer.move("end");
        expect(buffer.cursor.col).toBe(5);
      });
    });
  });

  describe("clear() - 清空文本", () => {
    it("应该清空所有文本", () => {
      buffer.insert("Hello");
      buffer.clear();
      expect(buffer.text).toBe("");
      expect(buffer.lines).toEqual([""]);
      expect(buffer.cursor).toEqual({ row: 0, col: 0 });
    });
  });

  describe("undo/redo - 撤销重做", () => {
    // 注意：历史机制保存的是操作前的状态
    // _saveHistory() 在每次操作前调用，保存当前文本到历史
    // 例如：
    // - 初始: text = "", history = [], historyIndex = -1
    // - insert("Hello"): _saveHistory() → history = [""], historyIndex = 0, 然后 text = "Hello"
    // - insert(" World"): _saveHistory() → history = ["", "Hello"], historyIndex = 1, 然后 text = "Hello World"
    // - undo(): historyIndex-- → 0, text = history[0] = ""

    it("undo 应该回到操作前的状态", () => {
      buffer.insert("Hello");
      buffer.insert(" World");
      // history = ["", "Hello"], historyIndex = 1, text = "Hello World"
      expect(buffer.text).toBe("Hello World");
      // undo() 会 historyIndex-- 然后加载 history[historyIndex]
      buffer.undo(); // historyIndex = 0, text = history[0] = ""
      expect(buffer.text).toBe("");
    });

    it("应该重做被撤销的操作", () => {
      buffer.insert("Hello");
      buffer.insert(" World");
      // history = ["", "Hello"], historyIndex = 1, text = "Hello World"
      buffer.undo(); // historyIndex = 0, text = ""
      // redo() 会 historyIndex++ 然后加载 history[historyIndex]
      buffer.redo(); // historyIndex = 1, text = history[1] = "Hello"
      expect(buffer.text).toBe("Hello");
    });

    it("新操作应该清除重做历史", () => {
      buffer.insert("A");
      buffer.insert("B");
      // history = ["", "A"], historyIndex = 1, text = "AB"
      buffer.undo(); // historyIndex = 0, text = ""
      buffer.insert("C"); // _saveHistory() 切片历史到 [0:1] = [""], 添加 "C", history = ["", "C"]
      expect(buffer.text).toBe("C");
      buffer.redo(); // historyIndex 已经在最大值，无法 redo
      expect(buffer.text).toBe("C"); // 保持不变
    });

    it("在历史起点时 undo 应该返回 false", () => {
      expect(buffer.undo()).toBe(false);
    });

    it("在没有重做历史时 redo 应该返回 false", () => {
      expect(buffer.redo()).toBe(false);
    });
  });

  describe("多行编辑场景", () => {
    it("应该在多行中正确导航和编辑", () => {
      // 创建多行文本
      buffer.setText("function hello() {\n  console.log('hi');\n}");

      // 移动到第二行开头
      buffer.move("down");
      buffer.move("home");

      // 在缩进后插入
      buffer.move("right");
      buffer.move("right");
      buffer.insert("debugger;\n  ");

      expect(buffer.lines.length).toBe(4);
      expect(buffer.lines[1]).toContain("debugger");
    });

    it("应该正确处理空行", () => {
      buffer.setText("A\n\nB");
      expect(buffer.lines).toEqual(["A", "", "B"]);

      buffer.move("down");
      expect(buffer.cursor.row).toBe(1);
      expect(buffer.cursor.col).toBe(0);

      buffer.insert("X");
      expect(buffer.lines[1]).toBe("X");
    });
  });

  describe("边界情况", () => {
    it("应该处理空字符串插入", () => {
      buffer.insert("");
      expect(buffer.text).toBe("");
    });

    it("应该处理只包含换行符的文本", () => {
      buffer.setText("\n\n");
      expect(buffer.lines).toEqual(["", "", ""]);
      expect(buffer.lineCount).toBe(3);
    });

    it("应该处理连续的退格到空", () => {
      buffer.insert("ABC");
      buffer.backspace();
      buffer.backspace();
      buffer.backspace();
      expect(buffer.text).toBe("");
      expect(buffer.cursor.col).toBe(0);
    });

    it("应该处理连续的换行", () => {
      buffer.newline();
      buffer.newline();
      buffer.newline();
      expect(buffer.lineCount).toBe(4);
    });
  });

  describe("isLineContinuation() - 行续行检测", () => {
    it("应该检测行尾的反斜杠", () => {
      buffer.insert("line1\\");
      expect(buffer.isLineContinuation()).toBe(true);
    });

    it("应该不检测非反斜杠结尾", () => {
      buffer.insert("line1");
      expect(buffer.isLineContinuation()).toBe(false);
    });

    it("双反斜杠仍然检测为续行（当前实现行为）", () => {
      // 注意：当前实现只检查行尾是否为 \，不处理转义情况
      buffer.insert("line1\\\\");
      expect(buffer.isLineContinuation()).toBe(true);
    });
  });

  describe("killLineLeft/Right - 删除到行首/行尾", () => {
    it("应该删除光标到行首的内容", () => {
      buffer.insert("Hello World");
      buffer.move("home"); // 先移到行首
      buffer.move("right");
      buffer.move("right");
      buffer.move("right");
      buffer.move("right");
      buffer.move("right");
      buffer.move("right"); // 在 'W' 位置，col=6
      buffer.killLineLeft(); // 删除 "Hello " 并将光标移到行首
      expect(buffer.text).toBe("World");
      expect(buffer.cursor.col).toBe(0);
    });

    it("应该删除光标到行尾的内容", () => {
      buffer.insert("Hello World");
      buffer.move("home"); // 先移到行首
      buffer.move("right");
      buffer.move("right");
      buffer.move("right");
      buffer.move("right");
      buffer.move("right");
      buffer.move("right"); // 在 'W' 位置，col=6
      buffer.killLineRight(); // 删除 "World"
      expect(buffer.text).toBe("Hello ");
    });
  });

  describe("deleteWordLeft - 删除前一个单词", () => {
    it("应该删除光标前的一个单词", () => {
      buffer.insert("Hello World Test");
      buffer.move("end");
      buffer.deleteWordLeft();
      expect(buffer.text).toBe("Hello World ");
    });

    it("应该处理多个连续空格", () => {
      buffer.insert("Hello   World");
      buffer.move("end");
      buffer.deleteWordLeft();
      expect(buffer.text).toBe("Hello   ");
    });
  });

  describe("视觉光标", () => {
    it("应该计算 ASCII 的视觉宽度", () => {
      buffer.insert("Hello");
      expect(buffer.currentLineVisualWidth).toBe(5);
    });

    it("应该计算 CJK 的视觉宽度", () => {
      buffer.insert("你好");
      expect(buffer.currentLineVisualWidth).toBe(4); // 每个 CJK 字符宽度为 2
    });

    it("应该计算混合内容的视觉宽度", () => {
      buffer.insert("Hi你好");
      expect(buffer.currentLineVisualWidth).toBe(6); // 2*1 + 2*2 = 6
    });

    it("应该返回正确的视觉光标位置 - ASCII", () => {
      buffer.insert("Hello");
      buffer.move("home");
      buffer.move("right");
      buffer.move("right");
      expect(buffer.visualCursor.col).toBe(2);
    });

    it("应该返回正确的视觉光标位置 - CJK", () => {
      buffer.insert("你好世界");
      buffer.move("home");
      buffer.move("right"); // 移到 '好' 位置
      expect(buffer.visualCursor.col).toBe(2); // '你' 宽度为 2
    });

    it("应该将视觉列转换为逻辑列", () => {
      buffer.insert("你好好");
      // 视觉宽度: 2 + 2 + 2 = 6
      // 视觉列 3 应该对应逻辑列 1（'好' 的开始）
      expect(buffer.visualColToLogicalCol(3)).toBe(1);
      expect(buffer.visualColToLogicalCol(4)).toBe(2);
    });

    it("应该移动到视觉列位置", () => {
      buffer.insert("你好好");
      buffer.moveToVisualCol(3);
      expect(buffer.cursor.col).toBe(1);
    });

    it("应该获取光标位置的字符宽度", () => {
      buffer.insert("你A好");
      buffer.move("home");
      expect(buffer.getCharWidthAtCursor()).toBe(2); // '你' 是宽字符
      buffer.move("right");
      expect(buffer.getCharWidthAtCursor()).toBe(1); // 'A' 是窄字符
    });
  });
});
