from typing import List, Optional
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from ortools.constraint_solver import pywrapcp, routing_enums_pb2

app = FastAPI(title="OR-Tools Solver API", version="0.2.0")


class SolveRequest(BaseModel):
    client_ids: List[str] = Field(..., min_length=2)
    matrix_minutes: List[List[int]] = Field(...)
    service_minutes: Optional[List[int]] = None

    # LOCKED/PRIORITY
    locked_positions: Optional[List[Optional[int]]] = None  # 각 노드의 '방문 순서' 고정값 (없으면 None)
    priority_flags: Optional[List[bool]] = None             # 각 노드 priority 여부

    start_index: int = Field(0, ge=0)
    end_index: int = Field(0, ge=0)
    time_limit_seconds: int = Field(3, ge=1, le=30)


class SolveResponse(BaseModel):
    order: List[str]                  # HOME 포함, end 포함
    visit_order: List[str]            # HOME 제외 방문 순서
    total_travel_minutes: int
    total_service_minutes: int
    total_cost_minutes: int
    status: str


def _validate(req: SolveRequest):
    n = len(req.client_ids)

    if len(req.matrix_minutes) != n or any(len(r) != n for r in req.matrix_minutes):
        raise HTTPException(400, "matrix_minutes must be NxN and match client_ids length")
    if any((not isinstance(x, int)) or x < 0 for r in req.matrix_minutes for x in r):
        raise HTTPException(400, "matrix_minutes must contain non-negative integers")

    if req.service_minutes is None:
        req.service_minutes = [0] * n
    if len(req.service_minutes) != n or any((not isinstance(x, int)) or x < 0 for x in req.service_minutes):
        raise HTTPException(400, "service_minutes must match length and be non-negative ints")

    if req.locked_positions is None:
        req.locked_positions = [None] * n
    if len(req.locked_positions) != n:
        raise HTTPException(400, "locked_positions length must match client_ids length")
    for v in req.locked_positions:
        if v is not None and ((not isinstance(v, int)) or v < 0):
            raise HTTPException(400, "locked_positions must be int>=0 or null")

    if req.priority_flags is None:
        req.priority_flags = [False] * n
    if len(req.priority_flags) != n:
        raise HTTPException(400, "priority_flags length must match client_ids length")

    if not (0 <= req.start_index < n) or not (0 <= req.end_index < n):
        raise HTTPException(400, "start_index/end_index out of range")

    # LOCKED 충돌 체크 (같은 방문순서 두 개 이상 고정이면 불가능)
    locked_vals = [v for v in req.locked_positions if v is not None]
    if len(locked_vals) != len(set(locked_vals)):
        raise HTTPException(400, "locked_positions has duplicate fixed positions (conflict)")


@app.post("/solve", response_model=SolveResponse)
def solve(req: SolveRequest):
    _validate(req)
    n = len(req.client_ids)

    # 차량 1대, start/end 고정
    manager = pywrapcp.RoutingIndexManager(n, 1, [req.start_index], [req.end_index])
    routing = pywrapcp.RoutingModel(manager)

    # 비용: travel(i,j) + service(i)
    def cost_cb(from_index: int, to_index: int) -> int:
        i = manager.IndexToNode(from_index)
        j = manager.IndexToNode(to_index)
        return int(req.matrix_minutes[i][j] + req.service_minutes[i])

    transit_cb = routing.RegisterTransitCallback(cost_cb)
    routing.SetArcCostEvaluatorOfAllVehicles(transit_cb)

    # -----------------------------
    # 1) 방문 순서(Count) Dimension
    # -----------------------------
    def step_cb(from_index: int, to_index: int) -> int:
        # 이동할 때마다 +1 (방문 카운트 증가)
        return 1

    step_cb_idx = routing.RegisterTransitCallback(step_cb)

    routing.AddDimension(
        step_cb_idx,
        0,          # slack
        n + 2,      # capacity
        True,       # start cumul = 0
        "COUNT"
    )
    count_dim = routing.GetDimensionOrDie("COUNT")

    # -----------------------------
    # 2) LOCKED: 정확히 k번째 방문 고정
    # -----------------------------
    for node, fixed_pos in enumerate(req.locked_positions):
        if fixed_pos is None:
            continue

        idx = manager.NodeToIndex(node)

        # end 노드는 "마지막 도착"이라 count 고정이 충돌을 만들 수 있어 일반적으로 제외
        if routing.IsEnd(idx):
            continue

        count_dim.CumulVar(idx).SetValue(int(fixed_pos))

    # -----------------------------
    # 3) PRIORITY: UNLOCKED끼리만 먼저 오도록
    # -----------------------------
    unlocked_nodes = [i for i, lp in enumerate(req.locked_positions) if lp is None]
    prio_nodes = [i for i in unlocked_nodes if req.priority_flags[i]]
    nonprio_nodes = [i for i in unlocked_nodes if not req.priority_flags[i]]

    for p in prio_nodes:
        p_idx = manager.NodeToIndex(p)
        if routing.IsEnd(p_idx):
            continue
        for q in nonprio_nodes:
            q_idx = manager.NodeToIndex(q)
            if routing.IsEnd(q_idx):
                continue
            routing.solver().Add(count_dim.CumulVar(p_idx) <= count_dim.CumulVar(q_idx))

    # -----------------------------
    # Solve
    # -----------------------------
    params = pywrapcp.DefaultRoutingSearchParameters()
    params.first_solution_strategy = routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC
    params.local_search_metaheuristic = routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    params.time_limit.seconds = int(req.time_limit_seconds)

    sol = routing.SolveWithParameters(params)
    if sol is None:
        raise HTTPException(500, "No solution found (constraints may be too tight)")

    # route extract
    index = routing.Start(0)
    route_nodes = []
    travel_sum = 0
    service_sum = 0

    while not routing.IsEnd(index):
        i = manager.IndexToNode(index)
        route_nodes.append(i)

        nxt = sol.Value(routing.NextVar(index))
        j = manager.IndexToNode(nxt)

        travel_sum += int(req.matrix_minutes[i][j])
        service_sum += int(req.service_minutes[i])

        index = nxt

    route_nodes.append(manager.IndexToNode(index))  # end

    order = [req.client_ids[i] for i in route_nodes]
    visit_order = [req.client_ids[i] for i in route_nodes[1:-1]]  # HOME 제외

    return SolveResponse(
        order=order,
        visit_order=visit_order,
        total_travel_minutes=travel_sum,
        total_service_minutes=service_sum,
        total_cost_minutes=travel_sum + service_sum,
        status="OK",
    )
