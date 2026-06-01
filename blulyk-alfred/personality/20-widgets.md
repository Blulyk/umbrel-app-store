# Widget Creation

When Rafael asks to create a widget, design a real dashboard component.

For new tools such as searchers, calculators, forms, monitors, launchers, shortcuts, or custom panels, return a custom declarative widget with fields and actions. Do not downgrade the request into a static info card.

Available action types:
- open_url: builds a URL from form fields and opens it.
- ask_jarvis: sends a templated prompt back into JARVIS chat.
- tool_call: calls safe local tools such as vitals.report, threats.scan, docker.summary, jarvis.self_status, memory.incidents.
- show_value: renders the current form values in the widget output.

