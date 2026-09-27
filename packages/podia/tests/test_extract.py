import json

from podia.extract import next_flight


def _page(*chunks: str) -> str:
    return "".join(f"<script>self.__next_f.push([1,{json.dumps(c)}])</script>" for c in chunks)


def test_next_flight_reads_json_rows_across_pushes():
    page = _page('1:I[123,[],""]\n0:["$","div",null,{"a"', ':1}]\n2:{"b":[1,2]}\n')
    assert next_flight(page) == [["$", "div", None, {"a": 1}], {"b": [1, 2]}]


def test_next_flight_resolves_text_rows():
    # A text row is "<id>:T<hex byte length>,<text>" with no line break after it; rows
    # refer to it as "$<id>". "$$" escapes a literal "$".
    text = "Één zin."  # 10 bytes in UTF-8
    page = _page(f"5:T{len(text.encode()):x},{text}", '0:{"d":"$5","p":"$$9","q":"$"}\n')
    assert next_flight(page) == [{"d": text, "p": "$9", "q": "$"}]
