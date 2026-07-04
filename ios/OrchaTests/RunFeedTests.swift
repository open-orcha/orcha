import Foundation
import Testing
@testable import Orcha

/// A 1:1 Swift Testing port of the Android `RunFeedTest.kt`: the run-line classifier
/// (RunFeed.classifyLine / classifyCodex, web app.js 1288-1439) against captured real
/// stream-json lines — narration, thinking, tool calls, orcha self-actions, results,
/// system frames, codex events, and the non-JSON fallback.
@Suite struct RunFeedTests {
    @Test func assistantTextBecomesNarration() {
        let rows = RunFeed.classifyLine(
            #"{"type":"assistant","message":{"content":[{"type":"text","text":"Investigating the four issues now."}]}}"#
        )
        #expect(rows.count == 1)
        #expect(rows[0].type == "narrate")
        #expect(rows[0].label == "narration")
        #expect(rows[0].text == "Investigating the four issues now.")
    }

    @Test func assistantThinkingCollapsesWithDetail() {
        let rows = RunFeed.classifyLine(
            #"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"secret chain of thought"}]}}"#
        )
        #expect(rows[0].type == "think")
        #expect(rows[0].text == "(thinking)")
        #expect(rows[0].detail == "secret chain of thought")
    }

    @Test func toolUseShowsNameWithInputAsDetail() {
        let rows = RunFeed.classifyLine(
            #"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"ls -la"}}]}}"#
        )
        #expect(rows[0].type == "tool")
        #expect(rows[0].text == "Bash")
        #expect(rows[0].detail?.contains("ls -la") == true)
    }

    @Test func orchaSelfActionToolCallIsADecisionRow() {
        // selfAction: input hitting an orcha skill/API path flips tool → orcha-action
        let rows = RunFeed.classifyLine(
            #"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"curl /api/tasks/123/done"}}]}}"#
        )
        #expect(rows[0].type == "decision")
        #expect(rows[0].label == "orcha-action")
    }

    @Test func toolResultRowAndDecisionResultRow() {
        let plain = RunFeed.classifyLine(
            #"{"type":"user","message":{"content":[{"type":"tool_result","content":"total 12"}]}}"#
        )
        #expect(plain[0].type == "result")
        #expect(plain[0].detail == "total 12")

        let decision = RunFeed.classifyLine(
            #"{"type":"user","message":{"content":[{"type":"tool_result","content":"{\"decision_id\":\"abc\"}"}]}}"#
        )
        #expect(decision[0].type == "decision")
    }

    @Test func systemInitIsBootAndResultIsDone() {
        let boot = RunFeed.classifyLine(#"{"type":"system","subtype":"init","cwd":"/repo"}"#)
        #expect(boot[0].type == "boot")
        #expect(boot[0].text.contains("/repo"))

        let done = RunFeed.classifyLine(#"{"type":"result","subtype":"success","result":"all four fixed"}"#)
        #expect(done[0].type == "done")
    }

    @Test func codexReasoningAndExecMap() {
        let reasoning = RunFeed.classifyLine(
            #"{"msg":{"type":"agent_reasoning_section_break"},"id":"1"}"#
        )
        #expect(reasoning[0].type == "think")

        let exec = RunFeed.classifyLine(
            #"{"msg":{"type":"exec_command_begin","command":["bash","-lc","ls"]},"id":"2"}"#
        )
        #expect(exec[0].type == "tool")
        #expect(exec[0].text == "exec")
    }

    @Test func nonJsonLineFallsBackToPlainLogRow() {
        let rows = RunFeed.classifyLine("plain progress text from a legacy worker")
        #expect(rows.count == 1)
        #expect(rows[0].type == "narrate")
        #expect(rows[0].label == "log")
    }

    @Test func blankLineYieldsNothing() {
        #expect(RunFeed.classifyLine("   ").isEmpty)
    }

    @Test func multiBlockAssistantMessageYieldsOneRowPerBlock() {
        let rows = RunFeed.classifyLine(
            #"""
            {"type":"assistant","message":{"content":[
                {"type":"text","text":"Running tests."},
                {"type":"tool_use","name":"Bash","input":{"command":"./gradlew test"}}
            ]}}
            """#
        )
        #expect(rows.count == 2)
        #expect(rows[0].type == "narrate")
        #expect(rows[1].type == "tool")
    }
}
